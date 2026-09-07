/**
 * The request for log files: which EventLogFile records an extraction wants, as SOQL.
 *
 * Pure string building, so the only part of the download that decides anything can be tested
 * without an org.
 */

export type LogFileInterval = 'Daily' | 'Hourly';

export const LOG_FILE_INTERVALS: readonly LogFileInterval[] = ['Daily', 'Hourly'];

/**
 * An EventType is an identifier: letters, digits and underscores. The names go into a SOQL
 * literal and into a file name, and this is what keeps a quote or a path separator out of both.
 */
const EVENT_TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateEventTypes(eventTypes: string[]): string[] {
  const invalid = eventTypes.filter((name) => !EVENT_TYPE_NAME.test(name));

  if (invalid.length > 0) {
    throw new Error(`An EventType is letters, digits and underscores, and this is not: ${invalid.join(', ')}`);
  }

  return eventTypes;
}

/** A YYYY-MM-DD flag value as the SOQL datetime literal for the start of that day. */
export function asSoqlDate(value: string, flagName: string): string {
  if (!CALENDAR_DATE.test(value)) {
    throw new Error(`--${flagName} must be a date as YYYY-MM-DD, and this was: ${value}`);
  }

  return `${value}T00:00:00Z`;
}

/**
 * The query that finds the files.
 *
 * `Interval` is always in the filter. An org with hourly event log files enabled keeps both the
 * hourly files and the daily file for the same day, and the daily one contains every row of the
 * hourly ones, so an extraction that took both would count every event twice.
 */
export function buildLogFileQuery(options: {
  eventTypes: string[];
  interval: LogFileInterval;
  startDate?: string;
  endDate?: string;
}): string {
  const conditions = [
    `EventType IN (${validateEventTypes(options.eventTypes)
      .map((name) => `'${name}'`)
      .join(', ')})`,
    `Interval = '${options.interval}'`,
  ];

  if (options.startDate) {
    conditions.push(`LogDate >= ${asSoqlDate(options.startDate, 'start-date')}`);
  }

  if (options.endDate) {
    conditions.push(`LogDate <= ${asSoqlDate(options.endDate, 'end-date')}`);
  }

  return (
    'SELECT Id, EventType, LogDate, LogFileLength, LogFileFieldNames FROM EventLogFile ' +
    `WHERE ${conditions.join(' AND ')} ORDER BY EventType, LogDate, CreatedDate`
  );
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }

  if (bytes < 1024 * 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
