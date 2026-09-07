import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { profileColumns, buildMetricsView, buildModel, displayName } from '../src/events/rill.ts';

const rows = (values: Array<Record<string, string>>) => values;

describe('profileColumns', () => {
  it('reads a column of numbers as something to aggregate', () => {
    const [profile] = profileColumns(['RUN_TIME'], rows([{ RUN_TIME: '120' }, { RUN_TIME: '90.5' }]));

    assert.equal(profile.role, 'numeric');
  });

  it('reads an ISO timestamp column as a candidate time axis', () => {
    const [profile] = profileColumns(
      ['TIMESTAMP_DERIVED'],
      rows([{ TIMESTAMP_DERIVED: '2026-09-07T12:00:00.000Z' }, { TIMESTAMP_DERIVED: '2026-09-07T12:00:01.000Z' }])
    );

    assert.equal(profile.role, 'timestamp');
  });

  it('reads a packed Salesforce timestamp as a time, not as a quantity', () => {
    // A real ApexRestApi log carries TIMESTAMP as 20260907120000.000, which parses as a number.
    // Summing a million timestamps means nothing, so the shape of the value has to be caught.
    const [profile] = profileColumns(
      ['TIMESTAMP'],
      rows([{ TIMESTAMP: '20260907120000.000' }, { TIMESTAMP: '20260907120001.500' }])
    );

    assert.equal(profile.role, 'timestamp');
    assert.equal(profile.timestampFormat, 'packed');
  });

  it('does not mistake a long number for a packed timestamp', () => {
    // Fourteen digits that are not a date: month 99 gives it away.
    const [profile] = profileColumns(['SIZE'], rows([{ SIZE: '99999999999999' }, { SIZE: '12345678901234' }]));

    assert.equal(profile.role, 'numeric');
  });

  it('separates a column that groups rows from one that identifies them', () => {
    const statuses = rows(Array.from({ length: 200 }, (_, i) => ({ STATUS: i % 2 === 0 ? '200' : '404' })));
    const ids = rows(Array.from({ length: 200 }, (_, i) => ({ REQUEST_ID: `req-${i}` })));

    assert.equal(profileColumns(['STATUS'], statuses)[0].role, 'numeric', 'status codes parse as numbers');
    assert.equal(profileColumns(['REQUEST_ID'], ids)[0].role, 'identifier');
  });

  it('keeps a low cardinality column as a dimension even when every row differs', () => {
    // Three rows, three values: the share is 1, but three values still group usefully.
    const [profile] = profileColumns(['EVENT'], rows([{ EVENT: 'a' }, { EVENT: 'b' }, { EVENT: 'c' }]));

    assert.equal(profile.role, 'dimension');
  });

  it('marks a column nobody filled as empty rather than guessing', () => {
    const [profile] = profileColumns(['UNUSED'], rows([{ UNUSED: '' }, { UNUSED: '' }]));

    assert.equal(profile.role, 'empty');
    assert.equal(profile.filled, 0);
  });
});

describe('buildMetricsView', () => {
  it('derives measures from numeric columns whose names it has never seen', () => {
    // The point of the rewrite: a column invented after this code was written still gets measures.
    const profiles = profileColumns(
      ['SOME_FUTURE_METRIC', 'PLATFORM', 'REQUEST_ID', 'TIMESTAMP_DERIVED'],
      rows(
        Array.from({ length: 100 }, (_, i) => ({
          SOME_FUTURE_METRIC: String(i),
          PLATFORM: i % 2 === 0 ? 'Lightning' : 'Classic',
          REQUEST_ID: `req-${i}`,
          TIMESTAMP_DERIVED: `2026-09-07T12:00:${String(i % 60).padStart(2, '0')}.000Z`,
        }))
      )
    );

    const view = buildMetricsView('model_name', 'A title', profiles);
    const measures = view.measures as Array<{ name: string; expression: string }>;
    const dimensions = view.dimensions as Array<{ name: string }>;

    assert.ok(measures.some((m) => m.expression === 'SUM(TRY_CAST(SOME_FUTURE_METRIC AS DOUBLE))'));
    assert.ok(measures.some((m) => m.expression === 'AVG(TRY_CAST(SOME_FUTURE_METRIC AS DOUBLE))'));
    assert.ok(
      measures.some((m) => m.expression === 'COUNT(DISTINCT REQUEST_ID)'),
      'identifiers get counted'
    );
    assert.deepEqual(
      dimensions.map((d) => d.name),
      ['PLATFORM'],
      'only the grouping column becomes a dimension'
    );
    assert.equal(view.timeseries, 'TIMESTAMP_DERIVED');
  });

  it('lets a low cardinality numeric column group as well as aggregate', () => {
    // A status code parses as a number and still describes rows, and nothing in the data says
    // which of the two it is.
    const profiles = profileColumns(
      ['STATUS_CODE', 'RUN_TIME'],
      rows(
        Array.from({ length: 200 }, (_, i) => ({
          STATUS_CODE: i % 3 === 0 ? '200' : '404',
          RUN_TIME: String(i * 7),
        }))
      )
    );

    const view = buildMetricsView('m', 't', profiles);
    const dimensions = (view.dimensions as Array<{ name: string }>).map((d) => d.name);
    const measures = (view.measures as Array<{ expression: string }>).map((m) => m.expression);

    assert.deepEqual(dimensions, ['STATUS_CODE'], 'the duration has too many values to group by');
    assert.ok(measures.includes('AVG(TRY_CAST(RUN_TIME AS DOUBLE))'));
    assert.ok(measures.includes('SUM(TRY_CAST(STATUS_CODE AS DOUBLE))'), 'still summable, oddly, and cheap');
  });

  it('keeps a packed timestamp out of the measures and off the axis', () => {
    // Excluded from the measures because summing it is meaningless, and off the axis because
    // DuckDB reads it as a number and Rill cannot put a number on a time axis.
    const profiles = profileColumns(
      ['TIMESTAMP', 'TIMESTAMP_DERIVED', 'RUN_TIME'],
      rows(
        Array.from({ length: 100 }, (_, i) => ({
          TIMESTAMP: `2026090712${String(i % 60).padStart(2, '0')}00.000`,
          TIMESTAMP_DERIVED: `2026-09-07T12:00:${String(i % 60).padStart(2, '0')}.000Z`,
          RUN_TIME: String(i),
        }))
      )
    );

    const view = buildMetricsView('m', 't', profiles);
    const measures = (view.measures as Array<{ expression: string }>).map((measure) => measure.expression);

    assert.ok(!measures.some((expression) => expression.includes('TIMESTAMP')), 'no timestamp is summed');
    assert.ok(measures.includes('SUM(TRY_CAST(RUN_TIME AS DOUBLE))'), 'the duration still is');
    assert.equal(view.timeseries, 'TIMESTAMP_DERIVED');
  });

  it('always defines a total, so a table with no numeric column still has a dashboard', () => {
    const view = buildMetricsView('m', 't', profileColumns(['PLATFORM'], rows([{ PLATFORM: 'Lightning' }])));
    const measures = view.measures as Array<{ expression: string }>;

    assert.deepEqual(
      measures.map((m) => m.expression),
      ['COUNT(*)']
    );
    assert.equal(view.timeseries, undefined, 'no timestamp column means no time axis');
  });
});

describe('displayName', () => {
  it('turns a log column into a label', () => {
    assert.equal(displayName('DB_TOTAL_TIME'), 'Db Total Time');
  });
});

describe('buildModel', () => {
  it('reads the Parquet file beside the project without copying it', () => {
    const model = buildModel('Login.parquet');

    assert.equal(model.sql, "select * from 'Login.parquet'\n");
    assert.equal(model.materialize, undefined);
  });
});
