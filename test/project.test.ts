import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRillProject } from '../src/events/project.ts';
import { convertToParquet, withDuckDB } from '../src/events/tables.ts';

const rill = spawnSync('rill', ['version'], { encoding: 'utf8' });
const rillAvailable = rill.status === 0;

describe('writeRillProject', () => {
  it('writes one model, metrics view and explore per table, and ignores the SQL beside them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shield-project-'));
    await writeFile(
      join(directory, 'Login.csv'),
      'LOG_DATE,USER_ID,RUN_TIME,TIMESTAMP_DERIVED\n2026-09-07,005A,12,2026-09-07T12:00:00.000Z\n2026-09-07,005B,30,2026-09-07T12:00:01.000Z\n',
      'utf8'
    );
    await writeFile(join(directory, 'shield.sql'), "CREATE VIEW Login AS SELECT * FROM 'Login.parquet';\n", 'utf8');

    const { built } = await withDuckDB(async (c) => {
      await convertToParquet(c, join(directory, 'Login.csv'), join(directory, 'Login.parquet'), 2);
      return writeRillProject(c, directory);
    });

    assert.equal(built.length, 1);
    assert.equal(built[0].timeseries, 'TIMESTAMP_DERIVED');
    assert.match(
      await readFile(join(directory, 'rill.yaml'), 'utf8'),
      /ignore_paths:\n {2}- \/shield.sql\n {2}- \/queries/
    );
    assert.match(await readFile(join(directory, 'models', 'Login_model.yaml'), 'utf8'), /from 'Login.parquet'/);

    await rm(directory, { recursive: true, force: true });
  });

  // The YAML this tool writes is a contract with whatever Rill is installed, and the only way to
  // hold it is to hand a project to that Rill. Skipped where there is none.
  it(
    'produces a project the installed Rill validates',
    { skip: !rillAvailable && 'rill is not installed' },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'shield-rill-'));
      await writeFile(
        join(directory, 'Search.csv'),
        'LOG_DATE,USER_ID,QUERY_ID,TIMESTAMP_DERIVED\n2026-09-07,005A,0,2026-09-07T12:00:00.000Z\n',
        'utf8'
      );
      await writeFile(join(directory, 'shield.sql'), "CREATE VIEW Search AS SELECT * FROM 'Search.parquet';\n", 'utf8');

      await withDuckDB(async (c) => {
        await convertToParquet(c, join(directory, 'Search.csv'), join(directory, 'Search.parquet'), 1);
        await writeRillProject(c, directory);
      });

      const validation = spawnSync('rill', ['validate', directory], { encoding: 'utf8', timeout: 120_000 });
      const output = `${validation.stdout}\n${validation.stderr}`;

      assert.match(output, /Validation completed successfully/, `${rill.stdout.trim()}\n${output}`);
      assert.doesNotMatch(output, /validation failed/);

      await rm(directory, { recursive: true, force: true });
    }
  );
});
