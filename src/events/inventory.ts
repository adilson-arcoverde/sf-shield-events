import { LOG_FILE_INTERVALS, type LogFileInterval } from './logfiles.ts';
import { formatBytes } from './logfiles.ts';

/**
 * What an org has: the event types, and for each one how many files, how many bytes and which
 * days. One query answers all of it, and both `discover` and the guided `extract` read it.
 *
 * Pure functions over the query's rows, so the choices the guide offers and the command line it
 * prints can be tested without an org or a terminal.
 */

/**
 * The aliases are `earliest` and `latest` rather than `first` and `last`, which SOQL reserves
 * for `NULLS FIRST` and rejects as aliases.
 */
export const INVENTORY_QUERY =
  'SELECT EventType, Interval, COUNT(Id) files, SUM(LogFileLength) bytes, MIN(LogDate) earliest, MAX(LogDate) latest ' +
  'FROM EventLogFile GROUP BY EventType, Interval';

/** A row of `INVENTORY_QUERY` as the org returns it. */
export type InventoryRecord = {
  EventType: string;
  Interval: string;
  files: number;
  bytes: number | null;
  earliest: string | null;
  latest: string | null;
};

export type EventTypeInventory = {
  eventType: string;
  interval: LogFileInterval;
  files: number;
  bytes: number;
  /** The first and last log dates, as YYYY-MM-DD. */
  earliest: string;
  latest: string;
};

/** The calendar date of a SOQL datetime, which for a LogDate is the day the file covers. */
function calendarDate(value: string | null): string {
  return (value ?? '').slice(0, 10);
}

/**
 * The org's rows as one sorted list, one entry per event type and interval.
 *
 * The query asks for no order because the platform ignores one on an aggregate anyway; sorting
 * here is what makes the list readable and the choices stable between runs.
 */
export function summarizeInventory(records: InventoryRecord[]): EventTypeInventory[] {
  return records
    .filter((record) => (LOG_FILE_INTERVALS as readonly string[]).includes(record.Interval))
    .map((record) => ({
      eventType: record.EventType,
      interval: record.Interval as LogFileInterval,
      files: Number(record.files),
      bytes: Number(record.bytes ?? 0),
      earliest: calendarDate(record.earliest),
      latest: calendarDate(record.latest),
    }))
    .sort((a, b) => a.eventType.localeCompare(b.eventType) || a.interval.localeCompare(b.interval));
}

/** Whether the org keeps hourly files at all, which is the only case where the interval is a choice. */
export function hasHourlyFiles(inventory: EventTypeInventory[]): boolean {
  return inventory.some((entry) => entry.interval === 'Hourly');
}

/** The entries of one interval, which is what an extraction reads. */
export function forInterval(inventory: EventTypeInventory[], interval: LogFileInterval): EventTypeInventory[] {
  return inventory.filter((entry) => entry.interval === interval);
}

/**
 * The first and last day across the chosen types, as the default date range.
 *
 * A guide that offered an empty date field would be asking the reader to know what the org
 * holds; this is the answer, and taking it as is means "everything you selected".
 */
export function dateBounds(entries: EventTypeInventory[]): { earliest: string; latest: string } | undefined {
  const dated = entries.filter((entry) => entry.earliest && entry.latest);

  if (dated.length === 0) {
    return undefined;
  }

  return {
    earliest: dated.map((entry) => entry.earliest).sort()[0],
    latest: dated
      .map((entry) => entry.latest)
      .sort()
      .at(-1) as string,
  };
}

/** One line of the selection list: the type, then what choosing it costs. */
export function describeChoice(entry: EventTypeInventory, nameWidth: number): string {
  const files = `${entry.files} ${entry.files === 1 ? 'file' : 'files'}`;
  const span = entry.earliest === entry.latest ? entry.latest : `${entry.earliest} to ${entry.latest}`;

  return `${entry.eventType.padEnd(nameWidth)}  ${files.padStart(9)}  ${formatBytes(entry.bytes).padStart(7)}  ${span}`;
}

/** A shell word, quoted only when it has to be. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The command line that would run this extraction without asking.
 *
 * This is the point of the guide: whoever answered its questions once can paste the answer
 * into a script. Flags at their default are left out, so the line says what was decided and
 * not what was left alone.
 */
export function equivalentCommand(options: {
  bin: string;
  targetOrg: string;
  eventTypes: string[];
  interval: LogFileInterval;
  startDate?: string;
  endDate?: string;
  outputDir: string;
  defaultOutputDir: string;
  concurrency: number;
  defaultConcurrency: number;
}): string {
  const words = [options.bin, 'shield', 'events', 'extract', '--target-org', shellWord(options.targetOrg)];

  for (const eventType of options.eventTypes) {
    words.push('-e', eventType);
  }

  if (options.interval !== 'Daily') {
    words.push('--interval', options.interval);
  }

  if (options.startDate) {
    words.push('--start-date', options.startDate);
  }

  if (options.endDate) {
    words.push('--end-date', options.endDate);
  }

  if (options.outputDir !== options.defaultOutputDir) {
    words.push('--output-dir', shellWord(options.outputDir));
  }

  if (options.concurrency !== options.defaultConcurrency) {
    words.push('--concurrency', String(options.concurrency));
  }

  words.push('--no-prompt');

  return words.join(' ');
}
