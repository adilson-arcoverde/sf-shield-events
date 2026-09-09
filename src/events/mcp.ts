import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { DuckDBConnection } from '@duckdb/node-api';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PROFILE_SAMPLE_ROWS } from './project.ts';
import { profileColumns, type ColumnRole } from './rill.ts';
import { sampleTable } from './tables.ts';

/**
 * An MCP server over an extraction directory, so that an assistant can ask the questions
 * instead of a person typing SQL.
 *
 * The directory is already a database: one Parquet table per event type, and a `queries/`
 * directory of ready-made questions. This module opens it the way `shield.sql` does and offers
 * five tools over it. Nothing here knows an org, a credential or a column name; what a column
 * is for comes from the same profiling that builds the dashboards.
 *
 * The tables are unredacted production logs, and the client on the other end of this server is
 * usually a model running somewhere else. So the server is read-only in the strongest sense
 * DuckDB offers, and every answer is capped at a number of rows. It answers questions; it does
 * not hand over a table.
 */

/** Rows a single answer may carry unless the command says otherwise. */
export const DEFAULT_ROW_LIMIT = 200;

/** The bytes of a SQL file read for its header comments. Real queries are a few hundred. */
const QUESTION_HEADER_BYTES = 4096;

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type Question = {
  /** The file name without `.sql`, which is how `run_question` names it. */
  name: string;
  /** The first comment line of the file, which is the question it answers. */
  question: string;
  /** The event types the query reads, from its `-- Needs:` line. */
  needs: string[];
};

export type ColumnDescription = {
  name: string;
  /** The DuckDB type of the Parquet column. */
  type: string;
  /** What the column is for, profiled from a reservoir sample of its values. */
  role: ColumnRole;
};

export type QueryResult = {
  columns: string[];
  rows: Array<Record<string, Json>>;
  /** True when the query had more rows than the limit, and the rest were left behind. */
  truncated: boolean;
  rowLimit: number;
};

/** A DuckDB JSON value as text, whether it came back already as a string or as a parsed value. */
function asString(value: Json): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** A SQL string literal. */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** A quoted SQL identifier. */
function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Opens every Parquet table in the directory as a view, then locks the connection down to it.
 *
 * The views use absolute paths, unlike `shield.sql`, because this process does not change into
 * the directory. Once they exist, DuckDB is told that the directory is the only file system
 * path it may read, that no other external access is allowed, and that the configuration may
 * not be changed again. A SELECT can still call `read_csv` on any path, and without this a
 * client could read any file on the machine through the log tables' server. With it the call
 * fails with a permission error, and so does a `SET` that tries to lift it.
 *
 * @returns The table names, sorted.
 */
export async function openExtraction(connection: DuckDBConnection, directory: string): Promise<string[]> {
  const absolute = resolve(directory);
  const tables = (await readdir(absolute))
    .filter((name) => name.endsWith('.parquet'))
    .map((name) => basename(name, '.parquet'))
    .sort((a, b) => a.localeCompare(b));

  for (const table of tables) {
    await connection.run(
      `CREATE OR REPLACE VIEW ${identifier(table)} AS SELECT * FROM read_parquet(${literal(join(absolute, `${table}.parquet`))})`
    );
  }

  await connection.run(`SET allowed_directories = [${literal(absolute)}]`);
  await connection.run('SET enable_external_access = false');
  await connection.run('SET lock_configuration = true');

  return tables;
}

/**
 * Reads the ready-made questions beside the tables.
 *
 * A query file opens with comment lines: the question it answers first, then whatever the
 * author wanted to say, then a `-- Needs:` line naming the event types it reads. Only the
 * header is read, since that is all a listing needs and a query never needs more than a few
 * hundred bytes of it.
 */
export async function listQuestions(directory: string): Promise<Question[]> {
  const folder = join(directory, 'queries');
  let files: string[];

  try {
    files = (await readdir(folder)).filter((name) => name.endsWith('.sql')).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }

  const questions: Question[] = [];

  for (const file of files) {
    const header = (await readFile(join(folder, file), 'utf8')).slice(0, QUESTION_HEADER_BYTES);
    const comments = header
      .split('\n')
      .filter((line) => line.startsWith('--'))
      .map((line) => line.replace(/^--\s?/, '').trim());
    const needs = comments.find((line) => line.startsWith('Needs:'));

    questions.push({
      name: basename(file, '.sql'),
      question: comments.find((line) => line.length > 0 && !line.startsWith('Needs:')) ?? '',
      needs: needs
        ? needs
            .slice('Needs:'.length)
            .split(',')
            .map((type) => type.trim())
            .filter((type) => type.length > 0)
        : [],
    });
  }

  return questions;
}

/**
 * Says what a table holds without showing any of it: each column's type and its role.
 *
 * The role comes from `profileColumns` over a reservoir sample, the same inference that decides
 * a dashboard's dimensions and measures, so an assistant learns which columns group rows and
 * which identify them before it writes a query. No sample value leaves this function: the
 * values are user ids, addresses and query text, and a description does not need them.
 */
export async function describeTable(
  connection: DuckDBConnection,
  directory: string,
  table: string
): Promise<{ table: string; rows: number; columns: ColumnDescription[] }> {
  const described = await connection.runAndReadAll(`DESCRIBE ${identifier(table)}`);
  const types = new Map(
    described.getRowObjectsJson().map((row) => [asString(row.column_name), asString(row.column_type)] as const)
  );

  const counted = await connection.runAndReadAll(`SELECT count(*) AS n FROM ${identifier(table)}`);
  const rows = Number(counted.getRowObjects()[0].n);

  const sample = await sampleTable(connection, join(resolve(directory), `${table}.parquet`), PROFILE_SAMPLE_ROWS);
  const roles = new Map(
    sample.length > 0
      ? profileColumns(Object.keys(sample[0]), sample).map((profile) => [profile.name, profile.role] as const)
      : []
  );

  return {
    table,
    rows,
    columns: [...types.keys()].map((name) => ({
      name,
      type: types.get(name) ?? 'VARCHAR',
      role: roles.get(name) ?? 'empty',
    })),
  };
}

/**
 * Runs one SELECT and returns at most `rowLimit` rows of it.
 *
 * The statement is handed to DuckDB's own parser first, through `json_serialize_sql`, which
 * serialises a SELECT and refuses anything else with an error. That is the gate: no COPY, no
 * CREATE, no INSTALL, no SET, whatever the text looks like, and one statement at a time. The
 * read then stops once the limit is passed rather than fetching the rest, so a question over a
 * million rows costs what its answer costs.
 */
export async function readOnlyQuery(connection: DuckDBConnection, sql: string, rowLimit: number): Promise<QueryResult> {
  const parsed = await connection.runAndReadAll('SELECT json_serialize_sql($1::VARCHAR) AS ast', [sql]);
  const ast = JSON.parse(asString(parsed.getRowObjectsJson()[0].ast)) as {
    error: boolean;
    error_message?: string;
    statements?: unknown[];
  };

  if (ast.error) {
    throw new Error(`Only a SELECT statement can run here. DuckDB said: ${ast.error_message ?? 'not a SELECT'}`);
  }

  if ((ast.statements ?? []).length !== 1) {
    throw new Error('One statement at a time.');
  }

  const reader = await connection.runAndReadUntil(sql, rowLimit + 1);
  const rows = reader.getRowObjectsJson();

  return {
    columns: reader.columnNames(),
    rows: rows.slice(0, rowLimit),
    truncated: rows.length > rowLimit,
    rowLimit,
  };
}

/** The text of a ready-made question, or an error naming the ones that exist. */
async function readQuestion(directory: string, name: string): Promise<string> {
  const questions = await listQuestions(directory);

  if (!questions.some((question) => question.name === name)) {
    throw new Error(`No question named ${name}. The questions are: ${questions.map((q) => q.name).join(', ')}.`);
  }

  return readFile(join(directory, 'queries', `${name}.sql`), 'utf8');
}

/**
 * Builds the server over an opened extraction.
 *
 * The tables must already have been opened with `openExtraction` on this connection, since that
 * is what created the views and locked the file system down. The server is not connected to a
 * transport here: the command puts it on stdio, and a test puts it on an in-memory pair.
 */
export function createShieldServer(
  connection: DuckDBConnection,
  directory: string,
  tables: string[],
  options: { rowLimit?: number; version: string }
): McpServer {
  const rowLimit = options.rowLimit ?? DEFAULT_ROW_LIMIT;

  const server = new McpServer(
    { name: 'sf-shield-events', version: options.version },
    {
      instructions: [
        'Salesforce Shield Event Monitoring logs, extracted into one table per event type.',
        'The rows are unredacted production data: user ids, IP addresses, URIs and query text.',
        `Prefer aggregates over row listings. Every answer is capped at ${rowLimit} rows and says when it was cut.`,
        'Start with list_tables and list_questions; describe_table says what each column is for.',
        'Times are TIMESTAMP_DERIVED, written by Salesforce in UTC.',
      ].join(' '),
    }
  );

  const asText = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

  server.registerTool(
    'list_tables',
    {
      title: 'List the extracted event types',
      description: 'One table per Salesforce event type in the extraction, with its row count.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const listed = [];

      for (const table of tables) {
        const counted = await connection.runAndReadAll(`SELECT count(*) AS n FROM ${identifier(table)}`);
        listed.push({ table, rows: Number(counted.getRowObjects()[0].n) });
      }

      return asText(listed);
    }
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe a table',
      description:
        'The columns of one table: DuckDB type and role. A dimension groups rows, an identifier is distinct per ' +
        'row and is worth counting rather than grouping, a numeric column is worth summing, a timestamp can be a ' +
        'time axis. No values are shown.',
      inputSchema: { table: z.string().describe('A table name from list_tables.') },
      annotations: { readOnlyHint: true },
    },
    async ({ table }) => {
      if (!tables.includes(table)) {
        throw new Error(`No table named ${table}. The tables are: ${tables.join(', ')}.`);
      }

      return asText(await describeTable(connection, directory, table));
    }
  );

  server.registerTool(
    'list_questions',
    {
      title: 'List the ready-made questions',
      description:
        'The SQL questions shipped beside the tables, each with the event types it needs. ' +
        'A question over an event type the extraction lacks fails with "table not found", which is the correct answer.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => asText(await listQuestions(directory))
  );

  server.registerTool(
    'run_question',
    {
      title: 'Run a ready-made question',
      description: `Runs one of the questions from list_questions and returns up to ${rowLimit} rows.`,
      inputSchema: { name: z.string().describe('A question name from list_questions.') },
      annotations: { readOnlyHint: true },
    },
    async ({ name }) => asText(await readOnlyQuery(connection, await readQuestion(directory, name), rowLimit))
  );

  server.registerTool(
    'query',
    {
      title: 'Run a SELECT',
      description:
        `Runs one SELECT over the tables and returns up to ${rowLimit} rows. Anything that is not a single SELECT ` +
        'is refused, and only the extraction directory can be read. Aggregate where you can: the rows are production logs.',
      inputSchema: { sql: z.string().describe('One SELECT statement in DuckDB SQL.') },
      annotations: { readOnlyHint: true },
    },
    async ({ sql }) => asText(await readOnlyQuery(connection, sql, rowLimit))
  );

  return server;
}
