import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import { LOG_DATE_COLUMN, undeclaredColumns } from './consolidate.ts';

export type AppendResult = {
  rows: number;
  /** Columns the file carried that the declared header did not mention. */
  undeclared: string[];
  /**
   * Rows whose field count differs from the file's own header. They are kept, on the columns
   * they do fill, and counted, because a value dropped without a word is the one failure this
   * tool must not have.
   */
  malformed: { rows: number; firstRow?: number };
};

/**
 * Reads one log file from a stream and appends it to a table, without holding either in memory.
 *
 * A single event log file in a busy org runs past 400 MB, and the largest seen while building
 * this was 910 MB. That is beyond what a JavaScript string can hold, let alone what fits in a
 * heap next to the parsed rows, so nothing here buffers: bytes arrive, rows are stamped with the
 * day, and CSV goes out.
 *
 * The parser is asked for arrays rather than objects, so that a row wider or narrower than the
 * header is seen rather than silently trimmed or padded by the parser.
 */
export async function appendLogFile(options: {
  source: Readable;
  destination: string;
  header: string[];
  logDate: string;
  writeHeader: boolean;
}): Promise<AppendResult> {
  const result: AppendResult = { rows: 0, undeclared: [], malformed: { rows: 0 } };
  let fileHeader: string[] | undefined;

  const shape = new Transform({
    objectMode: true,
    transform(values: string[], _encoding, callback) {
      if (fileHeader === undefined) {
        fileHeader = values;
        // A shape mismatch is a property of the file, so it is read from the header once.
        result.undeclared = undeclaredColumns(Object.fromEntries(fileHeader.map((name) => [name, ''])), options.header);
        callback();
        return;
      }

      result.rows += 1;

      if (values.length !== fileHeader.length) {
        result.malformed.rows += 1;
        result.malformed.firstRow ??= result.rows;
      }

      const row: Record<string, string> = { [LOG_DATE_COLUMN]: options.logDate };

      for (const [index, name] of fileHeader.entries()) {
        row[name] = values[index] ?? '';
      }

      callback(null, row);
    },
  });

  await pipeline(
    options.source,
    parse({ skipEmptyLines: true, relaxColumnCount: true }),
    shape,
    stringify({ header: options.writeHeader, columns: options.header }),
    createWriteStream(options.destination, { flags: options.writeHeader ? 'w' : 'a' })
  );

  return result;
}
