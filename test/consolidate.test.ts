import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unionHeader, undeclaredColumns, LOG_DATE_COLUMN } from '../src/events/consolidate.ts';
import { appendLogFile } from '../src/events/stream.ts';

describe('unionHeader', () => {
  it('takes the union of what the org declares, so a changed shape loses nothing', () => {
    // The columns of an event type change between API versions, and an extraction spanning that
    // change would otherwise drop whatever the later files added.
    const header = unionHeader(['REQUEST_ID,RUN_TIME', 'REQUEST_ID,RUN_TIME,CPU_TIME']);

    assert.deepEqual(header, [LOG_DATE_COLUMN, 'REQUEST_ID', 'RUN_TIME', 'CPU_TIME']);
  });

  it('puts the log date first and ignores blank declarations', () => {
    assert.deepEqual(unionHeader(['', ' USER_ID , ']), [LOG_DATE_COLUMN, 'USER_ID']);
  });
});

describe('undeclaredColumns', () => {
  it('names what a file carried that the org did not declare', () => {
    assert.deepEqual(undeclaredColumns({ A: '1', SURPRISE: '2' }, [LOG_DATE_COLUMN, 'A']), ['SURPRISE']);
  });
});

describe('appendLogFile', () => {
  it('streams a file into a table, stamping every row with its day', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shield-'));
    const destination = join(directory, 'table.csv');
    const header = unionHeader(['REQUEST_ID,RUN_TIME', 'REQUEST_ID,RUN_TIME,CPU_TIME']);

    const first = await appendLogFile({
      source: Readable.from('REQUEST_ID,RUN_TIME\nA1,120\n'),
      destination,
      header,
      logDate: '2026-09-06',
      writeHeader: true,
    });

    const second = await appendLogFile({
      source: Readable.from('REQUEST_ID,RUN_TIME,CPU_TIME\nB2,90,45\n'),
      destination,
      header,
      logDate: '2026-09-07',
      writeHeader: false,
    });

    const written = await readFile(destination, 'utf8');

    assert.equal(first.rows, 1);
    assert.equal(second.rows, 1);
    assert.deepEqual(written.trim().split('\n'), [
      'LOG_DATE,REQUEST_ID,RUN_TIME,CPU_TIME',
      '2026-09-06,A1,120,',
      '2026-09-07,B2,90,45',
    ]);

    await rm(directory, { recursive: true, force: true });
  });

  it('reports a column the org failed to declare instead of failing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shield-'));
    const destination = join(directory, 'table.csv');

    const result = await appendLogFile({
      source: Readable.from('A,SURPRISE\n1,2\n'),
      destination,
      header: [LOG_DATE_COLUMN, 'A'],
      logDate: '2026-09-07',
      writeHeader: true,
    });

    assert.deepEqual(result.undeclared, ['SURPRISE']);
    assert.equal(result.rows, 1, 'the row is still written, minus the column nobody declared');

    await rm(directory, { recursive: true, force: true });
  });

  it('keeps quoted values that contain the delimiter intact', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shield-'));
    const destination = join(directory, 'table.csv');

    await appendLogFile({
      source: Readable.from('URI,STATUS\n"/one,two?a=1",200\n'),
      destination,
      header: [LOG_DATE_COLUMN, 'URI', 'STATUS'],
      logDate: '2026-09-07',
      writeHeader: true,
    });

    assert.match(await readFile(destination, 'utf8'), /"\/one,two\?a=1"/);

    await rm(directory, { recursive: true, force: true });
  });
});

describe('appendLogFile keeps a row of the wrong width, and says so', () => {
  it('counts rows wider or narrower than the file header and keeps what they fill', async () => {
    // A parser asked for objects would trim the wide row and pad the narrow one without a word.
    const directory = await mkdtemp(join(tmpdir(), 'shield-width-'));
    const destination = join(directory, 'table.csv');

    const result = await appendLogFile({
      source: Readable.from('A,B\n1,2\n3,4,EXTRA\n5\n7,8\n'),
      destination,
      header: [LOG_DATE_COLUMN, 'A', 'B'],
      logDate: '2026-09-07',
      writeHeader: true,
    });

    assert.equal(result.rows, 4);
    assert.deepEqual(result.malformed, { rows: 2, firstRow: 2 });

    const written = await readFile(destination, 'utf8');
    assert.match(written, /2026-09-07,3,4\n/);
    assert.match(written, /2026-09-07,5,\n/);

    await rm(directory, { recursive: true, force: true });
  });
});
