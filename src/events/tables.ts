import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

/**
 * The table side of the tool: turning a streamed CSV into a Parquet file, sampling a Parquet
 * file for profiling, and writing the script that makes a directory of Parquet files queryable.
 *
 * Everything here goes through DuckDB, which the plugin carries so the reader does not have to
 * install it. Nothing here knows an org or a column name.
 */

/**
 * How much memory DuckDB may use. Left to its default, DuckDB takes most of the machine, and
 * converting a 920 MB CSV peaked at 2.45 GB of resident memory; that would put the extraction's
 * memory back in proportion to file size, which is the one property the streaming download
 * exists to avoid. At this limit the same conversion peaks at 460 MB and runs in half the time,
 * because the buffer manager evicts what it no longer needs instead of hoarding it.
 */
const MEMORY_LIMIT = '256MB';

/**
 * The types DuckDB may give a column, chosen so that nothing is lost on the way to Parquet.
 *
 * DOUBLE is left out on purpose. Salesforce writes some timestamps packed as digits with three
 * decimals, and as a double `20260907120001.001` reads back as `20260907120001.0`: the
 * millisecond is gone. A decimal type would keep it but turns `001`, which is a key prefix,
 * into `1`. So a column that is not a whole number, a date, a timestamp or a boolean stays text,
 * exactly as the org wrote it, and whoever aggregates it casts. DuckDB keeps a whole number with
 * a leading zero as text on its own.
 */
const LOSSLESS_TYPES = ['BOOLEAN', 'BIGINT', 'DATE', 'TIMESTAMP', 'TIMESTAMPTZ', 'VARCHAR'];

/** Runs `work` against an in-memory DuckDB and closes it afterwards, whatever happened. */
export async function withDuckDB<T>(work: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();

  try {
    await connection.run(`SET memory_limit = '${MEMORY_LIMIT}'`);
    return await work(connection);
  } finally {
    try {
      connection.closeSync();
      instance.closeSync();
    } catch {
      // A failure to close an in-memory database is not actionable, and it must not replace
      // the error that `work` may be throwing.
    }
  }
}

/** A path as a SQL string literal. */
function literal(path: string): string {
  return `'${path.replaceAll("'", "''")}'`;
}

/**
 * Converts a consolidated CSV into a typed Parquet file and checks that no row was lost.
 *
 * DuckDB decides a column's type from a sample of the file, and a value later in the file that
 * does not fit the type either fails the read or, with `ignore_errors`, drops the row without a
 * word. Neither is acceptable for an extraction, so the sniffer is told to read the whole file
 * (`sample_size=-1`): one more pass over the CSV, in exchange for types that every row fits.
 * The dialect is not sniffed at all, because this tool wrote the file and knows it.
 *
 * The row count of the Parquet file is then compared with the number of rows that were streamed
 * into the CSV. A conversion that silently produced fewer rows is the failure this tool exists
 * to avoid, so a mismatch is an error rather than a warning.
 *
 * @param expectedRows How many rows were written into the CSV.
 * @returns The number of rows in the Parquet file, which equals `expectedRows` or throws.
 */
export async function convertToParquet(
  connection: DuckDBConnection,
  csvPath: string,
  parquetPath: string,
  expectedRows: number
): Promise<number> {
  await connection.run(
    `COPY (SELECT * FROM read_csv(${literal(csvPath)}, header=true, delim=',', quote='"', escape='"', ` +
      `sample_size=-1, auto_type_candidates=[${LOSSLESS_TYPES.map((type) => `'${type}'`).join(', ')}])) ` +
      `TO ${literal(parquetPath)} (FORMAT parquet, COMPRESSION zstd)`
  );

  const counted = await connection.runAndReadAll(`SELECT count(*) AS n FROM read_parquet(${literal(parquetPath)})`);
  const rows = Number(counted.getRowObjects()[0].n);

  if (rows !== expectedRows) {
    throw new Error(
      `${parquetPath} holds ${rows} rows but ${expectedRows} were extracted into ${csvPath}. ` +
        'The CSV was kept so the difference can be inspected.'
    );
  }

  return rows;
}

/**
 * Draws a reservoir sample of rows from a Parquet file, every value as text.
 *
 * Profiling wants an equal chance for every row, because a log file is ordered by time and any
 * contiguous slice lies about how many distinct values a column holds. DuckDB's reservoir sample
 * gives exactly that. The values come back as text so that the profiler sees what the org wrote
 * rather than what DuckDB typed it as, and the same profiler serves a CSV or a Parquet source.
 */
export async function sampleTable(
  connection: DuckDBConnection,
  parquetPath: string,
  limit: number
): Promise<Array<Record<string, string>>> {
  const result = await connection.runAndReadAll(
    `SELECT COLUMNS(*)::VARCHAR FROM read_parquet(${literal(parquetPath)}) USING SAMPLE reservoir(${limit} ROWS)`
  );

  return result
    .getRowObjects()
    .map((row) =>
      Object.fromEntries(Object.entries(row).map(([name, value]) => [name, typeof value === 'string' ? value : '']))
    );
}

/**
 * The script that turns a directory of Parquet files into named tables.
 *
 * A DuckDB database file is bound to the storage format of the version that wrote it, and the
 * DuckDB inside this plugin is not the one on the reader's machine. A script of views is text,
 * so any version opens it, and the Parquet files it points at are the durable part.
 *
 * Paths are relative, so the script has to be opened from the directory that holds it.
 */
export function buildViewsScript(tableNames: string[]): string {
  const lines = [
    '-- Generated by sf shield events extract. One view per extracted EventType.',
    '-- Open from this directory:  duckdb -init shield.sql',
    '-- Then, for a ready-made question:  .read queries/<name>.sql',
    '',
  ];

  for (const name of [...tableNames].sort((a, b) => a.localeCompare(b))) {
    lines.push(`CREATE OR REPLACE VIEW "${name}" AS SELECT * FROM '${name}.parquet';`);
  }

  return lines.join('\n') + '\n';
}
