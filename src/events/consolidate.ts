/** The column added to every row, so a consolidated table can be sliced by day. */
export const LOG_DATE_COLUMN = 'LOG_DATE';

/**
 * Builds the column list of a consolidated table from the field names the org declares.
 *
 * `EventLogFile` carries `LogFileFieldNames`, so the shape of every file is known from the query
 * that found it, before a byte is downloaded. That matters: a log file runs to hundreds of
 * megabytes, so it is read as a stream and written as it arrives, and a stream cannot wait to
 * see the last file before writing the first row. Taking the union from metadata keeps the
 * guarantee that a run spanning an API version change loses nothing.
 *
 * @param declaredFieldNames One comma separated list per file, as the org returned it.
 * @returns The column names, with the log date first, in order of first appearance.
 */
export function unionHeader(declaredFieldNames: string[]): string[] {
  const header = [LOG_DATE_COLUMN];

  for (const declaration of declaredFieldNames) {
    for (const name of declaration.split(',')) {
      const column = name.trim();

      if (column !== '' && !header.includes(column)) {
        header.push(column);
      }
    }
  }

  return header;
}

/**
 * Columns a row carries that the header does not, which means the org declared one shape and
 * delivered another.
 * @param row A parsed row.
 * @param header The column list in use.
 * @returns The unexpected column names.
 */
export function undeclaredColumns(row: Record<string, string>, header: string[]): string[] {
  return Object.keys(row).filter((column) => !header.includes(column));
}
