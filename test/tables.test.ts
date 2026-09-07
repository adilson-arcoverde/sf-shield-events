import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildViewsScript, convertToParquet, sampleTable, withDuckDB } from '../src/events/tables.ts';

describe('convertToParquet', () => {
  let directory: string;
  const csv = 'LOG_DATE,RUN_TIME,USER_ID,NOTE\n2026-09-01,120,005A,\n2026-09-01,90.5,005B,hello\n2026-09-02,7,005A,\n';

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), 'shield-tables-'));
    await writeFile(join(directory, 'Sample.csv'), csv, 'utf8');
  });

  after(() => rm(directory, { recursive: true, force: true }));

  it('writes every row and reports the count', async () => {
    const rows = await withDuckDB((c) =>
      convertToParquet(c, join(directory, 'Sample.csv'), join(directory, 'Sample.parquet'), 3)
    );

    assert.equal(rows, 3);
    await access(join(directory, 'Sample.parquet'));
  });

  it('refuses a conversion that lost rows rather than reporting success', async () => {
    await assert.rejects(
      withDuckDB((c) => convertToParquet(c, join(directory, 'Sample.csv'), join(directory, 'Lost.parquet'), 4)),
      /holds 3 rows but 4 were extracted/
    );
  });

  it('samples the table back as text, with an empty string where there was no value', async () => {
    const rows = await withDuckDB((c) => sampleTable(c, join(directory, 'Sample.parquet'), 20_000));

    assert.equal(rows.length, 3);
    assert.deepEqual(Object.keys(rows[0]), ['LOG_DATE', 'RUN_TIME', 'USER_ID', 'NOTE']);

    for (const row of rows) {
      for (const value of Object.values(row)) {
        assert.equal(typeof value, 'string');
      }
    }

    // RUN_TIME was typed as a number in the file and still comes back as the text the org wrote.
    assert.ok(rows.some((row) => row.RUN_TIME === '90.5'));
    assert.ok(rows.some((row) => row.NOTE === ''));
  });

  it('holds the sample to the limit', async () => {
    const rows = await withDuckDB((c) => sampleTable(c, join(directory, 'Sample.parquet'), 2));

    assert.equal(rows.length, 2);
  });

  it('keeps the CSV when the conversion fails', async () => {
    const kept = await readFile(join(directory, 'Sample.csv'), 'utf8');

    assert.equal(kept, csv);
  });
});

describe('convertToParquet keeps what the org wrote', () => {
  it('leaves a leading zero, a packed timestamp and a version number as text, and a count as a number', async () => {
    // KEY_PREFIX 001 is an object prefix, not the number one; the packed TIMESTAMP carries a
    // millisecond that a double would round away; API_VERSION 63.0 is a label. Only NUM_ROWS is
    // a quantity, and a whole one.
    const directory = await mkdtemp(join(tmpdir(), 'shield-types-'));
    await writeFile(
      join(directory, 'T.csv'),
      'KEY_PREFIX,TIMESTAMP,API_VERSION,NUM_ROWS,TIMESTAMP_DERIVED\n' +
        '001,20260907120000.980,63.0,1,2026-09-07T12:00:00.980Z\n' +
        '003,20260907120001.001,63.0,2,2026-09-07T12:00:01.001Z\n',
      'utf8'
    );

    const rows = await withDuckDB(async (c) => {
      await convertToParquet(c, join(directory, 'T.csv'), join(directory, 'T.parquet'), 2);
      const types = await c.runAndReadAll(`DESCRIBE SELECT * FROM read_parquet('${join(directory, 'T.parquet')}')`);
      const sample = await sampleTable(c, join(directory, 'T.parquet'), 10);
      return { types: types.getRowObjects().map((row) => [row.column_name, row.column_type]), sample };
    });

    assert.deepEqual(rows.types, [
      ['KEY_PREFIX', 'VARCHAR'],
      ['TIMESTAMP', 'VARCHAR'],
      ['API_VERSION', 'VARCHAR'],
      ['NUM_ROWS', 'BIGINT'],
      ['TIMESTAMP_DERIVED', 'TIMESTAMP WITH TIME ZONE'],
    ]);
    assert.ok(rows.sample.some((row) => row.KEY_PREFIX === '001' && row.TIMESTAMP === '20260907120000.980'));

    await rm(directory, { recursive: true, force: true });
  });

  it('accepts a table with a header and no rows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shield-empty-'));
    await writeFile(join(directory, 'E.csv'), 'A,B\n', 'utf8');

    const rows = await withDuckDB((c) =>
      convertToParquet(c, join(directory, 'E.csv'), join(directory, 'E.parquet'), 0)
    );

    assert.equal(rows, 0);
    await rm(directory, { recursive: true, force: true });
  });
});

describe('sampleTable over a long table', () => {
  it('reaches the tail of the file rather than sampling its head', async () => {
    // A log file is ordered by time, so its first rows are the first minutes of the day and say
    // nothing about cardinality. With 100 of 5,000 rows kept at random, the chance that none
    // comes from the last fifth is 0.8 to the hundredth, about two in ten billion.
    const directory = await mkdtemp(join(tmpdir(), 'shield-sample-'));
    const body = ['N', ...Array.from({ length: 5000 }, (_, i) => String(i))].join('\n') + '\n';
    await writeFile(join(directory, 'Long.csv'), body, 'utf8');

    const rows = await withDuckDB(async (c) => {
      await convertToParquet(c, join(directory, 'Long.csv'), join(directory, 'Long.parquet'), 5000);
      return sampleTable(c, join(directory, 'Long.parquet'), 100);
    });

    assert.equal(rows.length, 100);
    assert.ok(
      rows.some((row) => Number(row.N) >= 4000),
      'the tail of the file has to be reachable'
    );

    await rm(directory, { recursive: true, force: true });
  });
});

describe('buildViewsScript', () => {
  it('names one view per table, sorted, over the file beside the script', () => {
    const script = buildViewsScript(['Login', 'ApexExecution']);

    assert.match(script, /CREATE OR REPLACE VIEW "ApexExecution" AS SELECT \* FROM 'ApexExecution.parquet';/);
    assert.match(script, /CREATE OR REPLACE VIEW "Login" AS SELECT \* FROM 'Login.parquet';/);
    assert.ok(script.indexOf('ApexExecution') < script.indexOf('"Login"'));
  });

  it('tells the reader how to open it', () => {
    assert.match(buildViewsScript([]), /duckdb -init shield.sql/);
  });
});
