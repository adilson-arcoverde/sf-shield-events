import { cp, mkdir, readdir, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { setTimeout as sleep } from 'node:timers/promises';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Connection, SfError } from '@salesforce/core';
import type { DuckDBConnection } from '@duckdb/node-api';
import { unionHeader } from '../../../events/consolidate.ts';
import checkbox from '@inquirer/checkbox';
import input from '@inquirer/input';
import select from '@inquirer/select';
import { StateAggregator } from '@salesforce/core';
import { buildLogFileQuery, formatBytes, LOG_FILE_INTERVALS, type LogFileInterval } from '../../../events/logfiles.ts';
import {
  dateBounds,
  describeChoice,
  equivalentCommand,
  forInterval,
  hasHourlyFiles,
  INVENTORY_QUERY,
  summarizeInventory,
  type InventoryRecord,
} from '../../../events/inventory.ts';
import { appendLogFile, type AppendResult } from '../../../events/stream.ts';
import { buildViewsScript, convertToParquet, withDuckDB } from '../../../events/tables.ts';

type EventLogFileRecord = {
  Id: string;
  EventType: string;
  LogDate: string;
  LogFileLength: number;
  LogFileFieldNames: string;
};

export type ExtractResult = {
  eventType: string;
  files: number;
  rows: number;
  bytes: number;
  path: string;
};

/** Above this much to download, the command asks before spending the bandwidth. */
const CONFIRM_ABOVE_BYTES = 500 * 1024 * 1024;

/**
 * How many times one file is tried. An extraction of thirty days runs for hours, past the life
 * of a session, and a 900 MB body gives a connection plenty of time to drop; both are ordinary,
 * and neither should cost the files already written.
 */
const DOWNLOAD_ATTEMPTS = 3;

const SESSION_EXPIRED = 'LogFileSessionExpired';

/** Files are small compared with the round trip to fetch one, so a few at once pays; more than this and the org starts to notice. */
const DEFAULT_CONCURRENCY = 4;

const MAXIMUM_CONCURRENCY = 8;

const DEFAULT_OUTPUT_DIR = 'output';

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Downloads the log files an org has for the requested EventTypes and writes one table per type.
 *
 * Nothing here knows the name of an EventType or the columns one carries. The types come from
 * the org, and the columns come from `LogFileFieldNames`, which the query returns, so the shape
 * of the output is settled before the first byte arrives.
 */
export default class Extract extends SfCommand<ExtractResult[]> {
  public static readonly summary =
    'Download EventLogFile data for the given EventTypes and write one Parquet table per type.';

  public static readonly description = `Reads the log files the org has and consolidates each EventType into a single Parquet table, with a LOG_DATE column so days can be told apart.

The columns are the union of what the org declares across the matching files, because Salesforce changes them between API versions and a run spanning that change should not lose the difference.

Files are streamed to disk rather than buffered. Event log files are large: in a busy org they run past 400 MB each, so the command reports the total download and asks before anything over 500 MB.

Beside the tables the command writes shield.sql, which opens every table as a view in DuckDB, and a queries directory of ready-made questions. Open from the output directory with "duckdb -init shield.sql".

Without --event-type, in a terminal, the command asks: it lists the EventTypes the org has with their file counts, sizes and days, lets you pick, proposes the date range the org covers, and prints the command line that would do the same without asking. Outside a terminal, or with --json or --no-prompt, --event-type is required.

Run "sf shield events discover" to see which EventTypes an org has without extracting anything.`;

  public static readonly examples = [
    '<%= config.bin %> <%= command.id %> --target-org my-org',
    '<%= config.bin %> <%= command.id %> --target-org my-org --event-type ApexRestApi',
    '<%= config.bin %> <%= command.id %> --target-org my-org -e Login -e Logout --start-date 2026-09-01',
    '<%= config.bin %> <%= command.id %> --target-org my-org -e ApexExecution --no-prompt',
  ];

  public static readonly flags = {
    'target-org': Flags.requiredOrg(),
    'event-type': Flags.string({
      summary: 'EventType to download. Repeat the flag for more than one; leave it out to choose from a list.',
      multiple: true,
      char: 'e',
    }),
    interval: Flags.string({
      summary: 'Which files to read where the org keeps both: the daily file, or the hourly ones.',
      description:
        'An org with hourly event log files enabled has, for each day, the hourly files and a daily file holding every row of them. Reading both would count every event twice, so one is chosen.',
      options: [...LOG_FILE_INTERVALS],
      default: 'Daily',
    }),
    'start-date': Flags.string({ summary: 'Earliest log date to include, as YYYY-MM-DD.' }),
    'end-date': Flags.string({ summary: 'Latest log date to include, as YYYY-MM-DD.' }),
    'output-dir': Flags.directory({ summary: 'Where to write the tables.', default: DEFAULT_OUTPUT_DIR }),
    'no-prompt': Flags.boolean({
      summary: 'Download whatever matches without asking, however large. Makes --event-type required.',
      default: false,
    }),
    concurrency: Flags.integer({
      summary: 'How many EventTypes to download at once.',
      description:
        'Each EventType is one table, written by one stream, so types download in parallel while the files of a type stay in order. Conversions to Parquet run one at a time whatever this says, so memory does not grow with it.',
      default: DEFAULT_CONCURRENCY,
      min: 1,
      max: MAXIMUM_CONCURRENCY,
    }),
  };

  private downloaded = { files: 0, bytes: 0, totalFiles: 0, totalBytes: 0 };

  public async run(): Promise<ExtractResult[]> {
    const { flags } = await this.parse(Extract);
    const connection = flags['target-org'].getConnection();

    const request = {
      eventTypes: flags['event-type'] ?? [],
      interval: flags.interval as LogFileInterval,
      startDate: flags['start-date'],
      endDate: flags['end-date'],
    };

    if (request.eventTypes.length === 0) {
      if (!this.canAsk(flags['no-prompt'])) {
        throw new SfError('Missing required flag event-type.', 'MissingEventType', [
          'Pass --event-type once per type, or run the command in a terminal without --json or --no-prompt to choose from a list.',
        ]);
      }

      const chosen = await this.ask(connection, request);

      if (chosen === undefined) {
        return [];
      }

      Object.assign(request, chosen);

      this.log(
        '\nThe same extraction without the questions:\n  ' +
          equivalentCommand({
            bin: this.config.bin,
            targetOrg: await this.orgName(flags['target-org'].getUsername()),
            ...request,
            outputDir: flags['output-dir'],
            defaultOutputDir: DEFAULT_OUTPUT_DIR,
            concurrency: flags.concurrency,
            defaultConcurrency: DEFAULT_CONCURRENCY,
          }) +
          '\n'
      );
    }

    let query: string;

    try {
      query = buildLogFileQuery(request);
    } catch (error) {
      throw new SfError(error instanceof Error ? error.message : String(error), 'InvalidArguments');
    }

    const found = await connection.query<EventLogFileRecord>(query);

    if (found.records.length === 0) {
      this.log(
        'No log files match. Event log files are generated in batch after the fact, so a recent day may have nothing yet.'
      );
      return [];
    }

    const totalBytes = found.records.reduce((sum, record) => sum + (record.LogFileLength ?? 0), 0);

    this.log(`${found.records.length} files, ${formatBytes(totalBytes)} to download.`);

    if (totalBytes > CONFIRM_ABOVE_BYTES && !flags['no-prompt']) {
      const proceed = await this.confirm({ message: `That is ${formatBytes(totalBytes)}. Continue?` });

      if (!proceed) {
        this.log('Nothing downloaded. Narrow the date range, or pass --no-prompt to skip this question.');
        return [];
      }
    }

    await mkdir(flags['output-dir'], { recursive: true });

    const byType = new Map<string, EventLogFileRecord[]>();

    for (const record of found.records) {
      byType.set(record.EventType, [...(byType.get(record.EventType) ?? []), record]);
    }

    this.downloaded = { files: 0, bytes: 0, totalFiles: found.records.length, totalBytes };

    const results: ExtractResult[] = [];
    const failures: string[] = [];
    // Conversions share one DuckDB and run one after another, so the memory limit set on it is
    // the memory limit of the run and not of each type.
    let conversions: Promise<unknown> = Promise.resolve();
    const convert = <T>(work: () => Promise<T>): Promise<T> => {
      const next = conversions.then(work, work);
      conversions = next.catch(() => undefined);
      return next;
    };

    this.spinner.start('Downloading', this.downloadedStatus());

    await withDuckDB(async (duckdb) => {
      const queue = [...byType.entries()];
      const workers = Array.from({ length: Math.min(flags.concurrency, queue.length) }, async () => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          const [eventType, records] = next;

          try {
            results.push(await this.extractType(connection, duckdb, convert, flags['output-dir'], eventType, records));
          } catch (error) {
            // One type failing is that type's problem; the others still get written, and the
            // failure is reported at the end, when the reader is looking.
            failures.push(`${eventType}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      });

      await Promise.all(workers);
    });

    this.spinner.stop(`${this.downloaded.files} files, ${formatBytes(this.downloaded.bytes)}`);

    results.sort((a, b) => a.eventType.localeCompare(b.eventType));

    for (const result of results) {
      this.log(`${result.eventType}: ${result.rows} rows from ${result.files} files -> ${result.path}`);
    }

    await this.writeProject(flags['output-dir']);

    if (failures.length > 0) {
      throw new SfError(
        `${failures.length} of ${byType.size} EventTypes failed:\n${failures.join('\n')}`,
        'ExtractIncomplete',
        [
          'The tables that succeeded are written. Run the command again for the types listed; a table is replaced whole.',
        ]
      );
    }

    return results;
  }

  /**
   * Downloads every file of one EventType into its CSV, in date order, then converts the CSV
   * to Parquet. The files of a type are sequential because they append to one stream; it is
   * types that run in parallel.
   */
  private async extractType(
    connection: Connection,
    duckdb: DuckDBConnection,
    convert: <T>(work: () => Promise<T>) => Promise<T>,
    directory: string,
    eventType: string,
    records: EventLogFileRecord[]
  ): Promise<ExtractResult> {
    const header = unionHeader(records.map((record) => record.LogFileFieldNames ?? ''));
    const path = join(directory, `${eventType}.csv`);
    let rows = 0;
    let bytes = 0;

    for (const [index, record] of records.entries()) {
      const day = record.LogDate.slice(0, 10);

      const appended = await this.appendWithRetry(connection, record, {
        path,
        header,
        logDate: day,
        writeHeader: index === 0,
      });

      rows += appended.rows;
      bytes += record.LogFileLength ?? 0;
      this.downloaded.files += 1;
      this.downloaded.bytes += record.LogFileLength ?? 0;
      this.spinner.status = this.downloadedStatus();

      if (appended.undeclared.length > 0) {
        this.warn(
          `${eventType} ${day} carried columns the org did not declare, and they were dropped: ${appended.undeclared.join(
            ', '
          )}`
        );
      }

      if (appended.malformed.rows > 0) {
        this.warn(
          `${eventType} ${day}: ${appended.malformed.rows} rows did not match the file's own header, the first at row ${String(
            appended.malformed.firstRow
          )}. They were kept on the columns they fill.`
        );
      }
    }

    const table = join(directory, `${eventType}.parquet`);
    await convert(() => convertToParquet(duckdb, path, table, rows));
    // The CSV was only ever the streaming intermediate. It is kept when the conversion fails,
    // because then it is the evidence.
    await rm(path);

    return { eventType, files: records.length, rows, bytes, path: table };
  }

  private downloadedStatus(): string {
    const { files, bytes, totalFiles, totalBytes } = this.downloaded;

    return `${files} of ${totalFiles} files, ${formatBytes(bytes)} of ${formatBytes(totalBytes)}`;
  }

  /**
   * Appends one log file to its table, trying again when the download fails.
   *
   * Whatever a failed attempt managed to append is not trustworthy, so the table is cut back to
   * where this file began before the next attempt: the file is either in the table whole or not
   * at all, and a retry cannot double its rows. An expired session is refreshed rather than
   * waited out, since waiting would not help.
   */
  private async appendWithRetry(
    connection: Connection,
    record: EventLogFileRecord,
    options: { path: string; header: string[]; logDate: string; writeHeader: boolean }
  ): Promise<AppendResult> {
    const offset = options.writeHeader ? 0 : (await stat(options.path)).size;

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await appendLogFile({
          source: await this.openLogFile(connection, record.Id),
          destination: options.path,
          header: options.header,
          logDate: options.logDate,
          writeHeader: options.writeHeader,
        });
      } catch (error) {
        if (attempt >= DOWNLOAD_ATTEMPTS) {
          throw error;
        }

        // The table may not exist yet when the very first request fails.
        await truncate(options.path, offset).catch(() => undefined);

        const message = error instanceof Error ? error.message : String(error);
        this.warn(`${record.EventType} ${options.logDate}: attempt ${attempt} failed, ${message}`);

        if (error instanceof SfError && error.name === SESSION_EXPIRED) {
          await connection.refreshAuth();
        } else {
          await sleep(attempt * 2000);
        }
      }
    }
  }

  /**
   * Whether there is someone to ask. A pipe, a `--json` caller and `--no-prompt` all mean no.
   */
  private canAsk(noPrompt: boolean): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY) && !this.jsonEnabled() && !noPrompt;
  }

  /**
   * The org as the reader named it, so the printed command line reads back the way it was typed.
   */
  private async orgName(username: string | undefined): Promise<string> {
    if (!username) {
      return '';
    }

    const aliases = (await StateAggregator.getInstance()).aliases.getAll(username);
    return aliases[0] ?? username;
  }

  /**
   * Asks what to extract, in the order the answers depend on each other: the interval first,
   * since it changes which files exist, then the types with what each one costs, then the days.
   * Every default is what the org has, so accepting them means "all of it".
   *
   * @returns The choices, or `undefined` when the org has nothing to choose from.
   */
  private async ask(
    connection: Connection,
    given: { interval: LogFileInterval; startDate?: string; endDate?: string }
  ): Promise<{ eventTypes: string[]; interval: LogFileInterval; startDate?: string; endDate?: string } | undefined> {
    const inventory = summarizeInventory((await connection.query<InventoryRecord>(INVENTORY_QUERY)).records);

    if (inventory.length === 0) {
      this.log('No event log files in this org, or none visible to this user. Nothing to choose from.');
      return undefined;
    }

    let interval = given.interval;

    if (hasHourlyFiles(inventory)) {
      interval = await select<LogFileInterval>({
        message: 'This org keeps hourly files as well as daily ones. Which to read?',
        choices: LOG_FILE_INTERVALS.map((value) => ({
          value,
          name: value,
          description:
            value === 'Daily'
              ? 'One file per day per type.'
              : 'One file per hour per type; the daily file holds the same rows.',
        })),
        default: given.interval,
      });
    }

    const available = forInterval(inventory, interval);
    const width = Math.max(...available.map((entry) => entry.eventType.length));
    const eventTypes = await checkbox<string>({
      message: 'Which EventTypes? Space selects, enter confirms.',
      choices: available.map((entry) => ({ value: entry.eventType, name: describeChoice(entry, width) })),
      pageSize: 15,
      required: true,
      loop: false,
    });

    const bounds = dateBounds(available.filter((entry) => eventTypes.includes(entry.eventType)));
    const askDate = (message: string, fallback?: string) =>
      input({
        message,
        default: fallback,
        validate: (value) => CALENDAR_DATE.test(value) || 'A date as YYYY-MM-DD.',
      });

    const startDate = await askDate('From which day?', given.startDate ?? bounds?.earliest);
    const endDate = await askDate('Until which day?', given.endDate ?? bounds?.latest);

    return { eventTypes, interval, startDate, endDate };
  }

  /**
   * Makes the output directory openable as a database: a view per table over every Parquet
   * file present, not only the ones this run wrote, so extractions accumulate, and the
   * ready-made queries the plugin ships. A query already in the directory is left alone, because
   * the reader may have edited it.
   */
  private async writeProject(directory: string): Promise<void> {
    const tables = (await readdir(directory)).filter((name) => name.endsWith('.parquet'));

    await writeFile(join(directory, 'shield.sql'), buildViewsScript(tables.map((name) => basename(name, '.parquet'))));
    // The queries ship in the plugin's own package, and installed under the `sf` CLI the plugin's
    // root is not the CLI's: `this.config.root` is the CLI, and the directory does not exist there.
    const pluginRoot = this.config.plugins.get('sf-shield-events')?.root ?? this.config.root;
    await cp(join(pluginRoot, 'queries'), join(directory, 'queries'), { recursive: true, force: false });

    this.log(`\n${tables.length} tables in ${directory}. Open with: cd ${directory} && duckdb -init shield.sql`);
  }

  /**
   * Opens the body of one log file as a stream.
   *
   * `LogFile` is not a queryable field but a blob endpoint per record, and it answers with CSV
   * rather than JSON. The request goes through fetch with the connection's own credentials
   * because the jsforce client buffers a response, and buffering is the thing being avoided.
   */
  private async openLogFile(connection: Connection, recordId: string): Promise<Readable> {
    const url = `${connection.instanceUrl}/services/data/v${connection.getApiVersion()}/sobjects/EventLogFile/${recordId}/LogFile`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${connection.accessToken ?? ''}`, Accept: 'text/csv' },
    });

    if (response.status === 401) {
      throw new SfError(`The session expired while downloading log file ${recordId}.`, SESSION_EXPIRED);
    }

    if (!response.ok || !response.body) {
      throw new SfError(
        `Downloading log file ${recordId} failed with ${response.status} ${response.statusText}.`,
        'LogFileDownloadFailed'
      );
    }

    // The DOM ReadableStream and the one node:stream/web declares describe the same object at
    // runtime; only the two sets of type declarations disagree.
    return Readable.fromWeb(response.body as unknown as WebReadableStream);
  }
}
