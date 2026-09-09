import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createShieldServer, describeTable, listQuestions, openExtraction, readOnlyQuery } from '../src/events/mcp.ts';
import { convertToParquet } from '../src/events/tables.ts';

/**
 * A two-table extraction on disk, a locked connection over it, and an MCP client talking to a
 * server on that connection through an in-memory pipe. The whole surface is exercised the way a
 * client would, and the confinement is exercised the way an attacker would.
 */
describe('the MCP server over an extraction', () => {
  let directory: string;
  let outside: string;
  let connection: DuckDBConnection;
  let close: () => void;
  let client: Client;

  const login =
    'LOG_DATE,TIMESTAMP_DERIVED,USER_NAME,SOURCE_IP,LOGIN_STATUS,CPU_TIME\n' +
    '2026-09-01,2026-09-01T03:00:00.000Z,a@x.com,10.0.0.1,LOGIN_ERROR_INVALID_PASSWORD,12\n' +
    '2026-09-01,2026-09-01T03:00:05.000Z,a@x.com,10.0.0.1,LOGIN_ERROR_INVALID_PASSWORD,9\n' +
    '2026-09-01,2026-09-01T09:00:00.000Z,b@x.com,10.0.0.2,LOGIN_NO_ERROR,15\n' +
    '2026-09-02,2026-09-02T09:00:00.000Z,c@x.com,10.0.0.3,LOGIN_NO_ERROR,11\n';
  const api = 'LOG_DATE,CLIENT_NAME,COUNT\n2026-09-01,integration,100\n2026-09-01,mobile,5\n';

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'shield-mcp-'));
    outside = await mkdtemp(join(tmpdir(), 'shield-mcp-outside-'));
    await writeFile(join(outside, 'secret.csv'), 'k,v\n1,2\n', 'utf8');
    await writeFile(join(directory, 'Login.csv'), login, 'utf8');
    await writeFile(join(directory, 'ApiTotalUsage.csv'), api, 'utf8');
    await mkdir(join(directory, 'queries'));
    await writeFile(
      join(directory, 'queries', 'login_failures.sql'),
      '-- Failed logins by user and source address.\n-- A challenge is not a failure.\n-- Needs: Login\n' +
        "SELECT USER_NAME, SOURCE_IP, count(*) AS attempts FROM Login WHERE LOGIN_STATUS LIKE 'LOGIN_ERROR%' GROUP BY ALL;\n",
      'utf8'
    );
    await writeFile(join(directory, 'queries', 'README.md'), '# not a query\n', 'utf8');

    const instance = await DuckDBInstance.create(':memory:');
    const setup = await instance.connect();
    await convertToParquet(setup, join(directory, 'Login.csv'), join(directory, 'Login.parquet'), 4);
    await convertToParquet(setup, join(directory, 'ApiTotalUsage.csv'), join(directory, 'ApiTotalUsage.parquet'), 2);
    setup.closeSync();

    connection = await instance.connect();
    const tables = await openExtraction(connection, directory);
    const server = createShieldServer(connection, directory, tables, { rowLimit: 2, version: '0.0.0-test' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0' });
    await server.connect(serverSide);
    await client.connect(clientSide);
    close = () => {
      connection.closeSync();
      instance.closeSync();
    };
  });

  after(async () => {
    await client.close();
    close();
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const text = (result: Awaited<ReturnType<Client['callTool']>>): unknown => {
    const content = result.content as Array<{ type: string; text: string }>;
    return JSON.parse(content[0].text);
  };

  it('offers five read-only tools', async () => {
    const { tools } = await client.listTools();

    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'describe_table',
      'list_questions',
      'list_tables',
      'query',
      'run_question',
    ]);
    assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
  });

  it('lists the tables with their row counts, sorted', async () => {
    assert.deepEqual(text(await client.callTool({ name: 'list_tables', arguments: {} })), [
      { table: 'ApiTotalUsage', rows: 2 },
      { table: 'Login', rows: 4 },
    ]);
  });

  it('describes a table by type and role without showing a value', async () => {
    const described = (await describeTable(connection, directory, 'Login')) as {
      rows: number;
      columns: Array<{ name: string; type: string; role: string }>;
    };
    const byName = Object.fromEntries(described.columns.map((column) => [column.name, column]));

    assert.equal(described.rows, 4);
    assert.equal(byName.LOG_DATE.type, 'DATE');
    assert.equal(byName.TIMESTAMP_DERIVED.role, 'timestamp');
    assert.equal(byName.CPU_TIME.role, 'numeric');
    assert.equal(byName.CPU_TIME.type, 'BIGINT');
    assert.equal(byName.LOGIN_STATUS.role, 'dimension');
    assert.ok(!JSON.stringify(described).includes('a@x.com'));
  });

  it('refuses a table it does not have and names the ones it does', async () => {
    const result = await client.callTool({ name: 'describe_table', arguments: { table: 'Nope' } });

    assert.equal(result.isError, true);
    assert.match((result.content as Array<{ text: string }>)[0].text, /ApiTotalUsage, Login/);
  });

  it('lists the questions with what each one needs, and ignores the README', async () => {
    assert.deepEqual(await listQuestions(directory), [
      { name: 'login_failures', question: 'Failed logins by user and source address.', needs: ['Login'] },
    ]);
  });

  it('runs a ready-made question', async () => {
    const answer = text(await client.callTool({ name: 'run_question', arguments: { name: 'login_failures' } })) as {
      rows: Array<Record<string, unknown>>;
      truncated: boolean;
    };

    assert.equal(answer.rows.length, 1);
    assert.equal(answer.rows[0].attempts, '2');
    assert.equal(answer.truncated, false);
  });

  it('caps an answer at the row limit and says so', async () => {
    const answer = text(
      await client.callTool({ name: 'query', arguments: { sql: 'SELECT USER_NAME FROM Login ORDER BY 1' } })
    ) as { columns: string[]; rows: unknown[]; truncated: boolean; rowLimit: number };

    assert.deepEqual(answer.columns, ['USER_NAME']);
    assert.equal(answer.rows.length, 2);
    assert.equal(answer.truncated, true);
    assert.equal(answer.rowLimit, 2);
  });

  it('refuses anything that is not a single SELECT', async () => {
    for (const sql of [
      `COPY (SELECT 1) TO '${join(outside, 'leak.csv')}'`,
      'CREATE TABLE t AS SELECT 1',
      'SET enable_external_access = true',
      'INSTALL httpfs',
      'SELECT 1; SELECT 2',
    ]) {
      await assert.rejects(readOnlyQuery(connection, sql, 10), /Only a SELECT statement|One statement at a time/, sql);
    }
  });

  it('cannot read a file outside the extraction directory, even through a SELECT', async () => {
    await assert.rejects(
      readOnlyQuery(connection, `SELECT * FROM read_csv('${join(outside, 'secret.csv')}')`, 10),
      /Permission Error|disabled by configuration/
    );
  });

  it('can still read a Parquet file inside it by path', async () => {
    const answer = await readOnlyQuery(
      connection,
      `SELECT count(*) AS n FROM read_parquet('${join(directory, 'ApiTotalUsage.parquet')}')`,
      10
    );

    assert.equal(answer.rows[0].n, '2');
  });
});
