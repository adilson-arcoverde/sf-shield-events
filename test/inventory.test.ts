import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  dateBounds,
  describeChoice,
  equivalentCommand,
  forInterval,
  hasHourlyFiles,
  INVENTORY_QUERY,
  summarizeInventory,
  type InventoryRecord,
} from '../src/events/inventory.ts';

const records: InventoryRecord[] = [
  {
    EventType: 'Login',
    Interval: 'Daily',
    files: 30,
    bytes: 4_500_000,
    earliest: '2026-08-10T00:00:00.000+0000',
    latest: '2026-09-08T00:00:00.000+0000',
  },
  {
    EventType: 'ApexExecution',
    Interval: 'Daily',
    files: 15,
    bytes: 12_000_000,
    earliest: '2026-08-25T00:00:00.000+0000',
    latest: '2026-09-08T00:00:00.000+0000',
  },
  {
    EventType: 'ApexExecution',
    Interval: 'Hourly',
    files: 360,
    bytes: 12_000_000,
    earliest: '2026-08-25T00:00:00.000+0000',
    latest: '2026-09-08T00:00:00.000+0000',
  },
  { EventType: 'Odd', Interval: 'Weekly', files: 1, bytes: null, earliest: null, latest: null },
];

describe('summarizeInventory', () => {
  it('asks the org for the count, the bytes and the days in one query, grouped by type and interval', () => {
    assert.match(
      INVENTORY_QUERY,
      /COUNT\(Id\) files, SUM\(LogFileLength\) bytes, MIN\(LogDate\) earliest, MAX\(LogDate\) latest/
    );
    assert.match(INVENTORY_QUERY, /GROUP BY EventType, Interval$/);
  });

  it('sorts by type then interval, trims the dates to days, and drops an interval it cannot read', () => {
    const inventory = summarizeInventory(records);

    assert.deepEqual(
      inventory.map((entry) => `${entry.eventType}/${entry.interval}`),
      ['ApexExecution/Daily', 'ApexExecution/Hourly', 'Login/Daily']
    );
    assert.equal(inventory[2].earliest, '2026-08-10');
    assert.equal(inventory[2].latest, '2026-09-08');
    assert.equal(inventory[2].bytes, 4_500_000);
  });

  it('knows whether the interval is a choice at all', () => {
    assert.equal(hasHourlyFiles(summarizeInventory(records)), true);
    assert.equal(hasHourlyFiles(summarizeInventory([records[0]])), false);
  });

  it('narrows to one interval, since an extraction reads one', () => {
    const daily = forInterval(summarizeInventory(records), 'Daily');

    assert.deepEqual(
      daily.map((entry) => entry.eventType),
      ['ApexExecution', 'Login']
    );
  });
});

describe('dateBounds', () => {
  it('spans the chosen types', () => {
    assert.deepEqual(dateBounds(forInterval(summarizeInventory(records), 'Daily')), {
      earliest: '2026-08-10',
      latest: '2026-09-08',
    });
  });

  it('has nothing to say about an entry without dates', () => {
    assert.equal(
      dateBounds([{ eventType: 'X', interval: 'Daily', files: 0, bytes: 0, earliest: '', latest: '' }]),
      undefined
    );
  });
});

describe('describeChoice', () => {
  it('says what choosing a type costs', () => {
    const [apex, login] = forInterval(summarizeInventory(records), 'Daily');

    assert.equal(describeChoice(apex, 13), 'ApexExecution   15 files    11 MB  2026-08-25 to 2026-09-08');
    assert.equal(describeChoice(login, 13), 'Login           30 files     4 MB  2026-08-10 to 2026-09-08');
  });

  it('shows one day as one day', () => {
    const entry = {
      eventType: 'Login',
      interval: 'Daily' as const,
      files: 1,
      bytes: 2048,
      earliest: '2026-09-08',
      latest: '2026-09-08',
    };

    assert.equal(describeChoice(entry, 5), 'Login     1 file     2 KB  2026-09-08');
  });
});

describe('equivalentCommand', () => {
  const decided = {
    bin: 'sf',
    targetOrg: 'my-org',
    eventTypes: ['ApexExecution', 'Login'],
    interval: 'Daily' as const,
    startDate: '2026-09-01',
    endDate: '2026-09-08',
    outputDir: 'output',
    defaultOutputDir: 'output',
    concurrency: 4,
    defaultConcurrency: 4,
  };

  it('says what was decided and leaves the defaults out', () => {
    assert.equal(
      equivalentCommand(decided),
      'sf shield events extract --target-org my-org -e ApexExecution -e Login --start-date 2026-09-01 --end-date 2026-09-08 --no-prompt'
    );
  });

  it('names a flag once it left its default, and quotes what the shell would split', () => {
    assert.equal(
      equivalentCommand({
        ...decided,
        interval: 'Hourly',
        outputDir: 'my extraction',
        concurrency: 2,
        targetOrg: 'user@example.com',
      }),
      "sf shield events extract --target-org user@example.com -e ApexExecution -e Login --interval Hourly --start-date 2026-09-01 --end-date 2026-09-08 --output-dir 'my extraction' --concurrency 2 --no-prompt"
    );
  });
});
