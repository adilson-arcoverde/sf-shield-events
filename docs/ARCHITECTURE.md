# Architecture

How the pieces fit. For why each decision went this way, read [specs/](../specs/).

## The three commands and what flows between them

```
   the org                       output/                             output/
      |                             |                                   |
  discover  ---- names ---->    extract    ---- Parquet tables ---->  rill  ----> rill start
      |                             |                                   |
 GROUP BY EventType        one .parquet per type,              model, metrics view
 with a file count         shield.sql, queries/                and dashboard per type
                                    |
                                    +----> duckdb -init shield.sql
```

Each command is usable on its own. `discover` answers a question, `extract` produces a
queryable directory, and `rill` reads that directory. Nothing is passed in memory between them,
which means an extraction can be inspected, moved or re-explored without downloading it again.

`rill` is optional. The tables are already a database the moment `extract` finishes.

## Where the org connection comes from

Nowhere in this codebase. `Flags.requiredOrg()` from `@salesforce/sf-plugins-core` resolves the
`--target-org` flag against the authentications the `sf` CLI already holds and hands over a live
`Connection`. There is no token to store, no instance URL to track and no refresh to handle.

The one place that reaches past the query API is the log file body. `LogFile` is not a queryable
field: it is a blob endpoint per record, and it returns CSV rather than JSON.

That call is made with `fetch` and the connection's own access token rather than through the
jsforce client, because the client buffers a response and these responses cannot be buffered.
Log files in a busy org average 57 MB and reach 910 MB, past what a JavaScript string can hold.
The body is piped from the network through an incremental CSV parser into an incremental writer,
so memory follows the row width and not the file size: 381 MB and 1.3 million rows measured at a
peak of 175 MB. The parser hands over arrays rather than objects, so a row whose width differs
from the file's header is counted and reported instead of being trimmed or padded in silence.

EventTypes download in parallel, `--concurrency` at a time, each type appending its files in
date order to its own stream; a type that fails is reported at the end and does not stop the
rest. A download is tried up to three times. Before a retry the table is truncated to the byte
where that file began, so a file is in the table whole or not at all; a 401 refreshes the session
through the connection instead of waiting. The files to read come from one query, built and
tested in `events/logfiles.ts`, which validates each EventType name as an identifier (it goes
into a SOQL literal and a file name) and always filters on `Interval`, because an org with hourly
files keeps a daily file holding the same rows.

## From stream to table

The streamed CSV is an intermediate. When every file of an event type has been appended, DuckDB
reads the CSV with its type sniffer over the whole file, so every row fits the type it chooses,
and writes a zstd Parquet file. The dialect is not sniffed, since this tool wrote the file. The
types on offer are only the lossless ones: BOOLEAN, BIGINT, DATE, TIMESTAMP, TIMESTAMPTZ, else
VARCHAR. DOUBLE is not among them because a packed Salesforce timestamp loses its millisecond
as a double, and a decimal would turn the key prefix `001` into `1`. DuckDB runs under a 256 MB
memory limit so the conversion, like the download, does not grow with the file. The Parquet row
count is compared with the rows streamed; a mismatch keeps the CSV and fails the command, because
a conversion that loses rows quietly is the same failure as a download that does. On success the
CSV is deleted.

Then `shield.sql` is rebuilt with one `CREATE VIEW` per Parquet file present in the directory,
and the `queries/` directory the plugin ships is copied beside it, without overwriting a query
already there, since the reader may have edited it.

## The modules

| Module                               | Responsibility                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `commands/shield/events/discover.ts` | One query, one table of counts, and a clear failure when the object is not visible |
| `commands/shield/events/extract.ts`  | Query, download each file, group by event type, convert, write the project         |
| `commands/shield/events/rill.ts`     | Call `writeRillProject`, then say what it wrote                                    |
| `events/logfiles.ts`                 | The SOQL that finds the files: type names validated, interval, dates               |
| `events/consolidate.ts`              | The union of columns and the check that a file matches it. Knows nothing of orgs   |
| `events/stream.ts`                   | One log file, from a stream, appended to a CSV without being held                  |
| `events/tables.ts`                   | CSV to Parquet, the reservoir sample, the views script. All through DuckDB         |
| `events/project.ts`                  | The Rill project over a directory of tables, so a test can hand one to Rill        |
| `events/rill.ts`                     | Column profiling and the Rill resource shapes. Knows nothing about files           |
| `queries/*.sql`                      | One question each, over named event types and columns                              |

The modules under `events/` know nothing about orgs or the CLI. That is what lets the
interesting behaviour be tested without an org, and it is where the tests are. `tables.ts` runs
a real DuckDB in its tests, on files a few lines long, and `project.ts` hands a generated project
to the installed Rill for `rill validate`, skipping when there is none.

## How a column becomes a dimension or a measure

`profileColumns` works on a reservoir sample of 20,000 rows that DuckDB draws from the Parquet
file, every row with an equal chance. Reading the first rows instead would be faster and would
lie about cardinality, since a log file is ordered by time. The values are cast to text before
profiling, so the profiler sees what the org wrote. It looks at the values in this order:

1. No value in any row: `empty`. Left out of the dashboard and reported, since a column the org
   never fills is noise rather than signal.
2. Every value parses as an ISO timestamp: `timestamp`, and a candidate time axis.
3. Every value is digits in the form `20260907120000.000`: `timestamp` as well, since Salesforce
   packs some timestamps that way. Kept out of the measures, and not offered as the axis, because
   DuckDB types it as a number.
4. Every value parses as a finite number: `numeric`. Gets a total and an average.
5. More than 50 distinct values and a distinct value in more than half the rows: `identifier`.
   Gets a distinct count, and does not become a dimension because grouping by it would produce
   one group per row.
6. Anything else: `dimension`.

A `numeric` column with 50 distinct values or fewer also becomes a dimension. Status codes and
API versions parse as numbers and still describe rows, and no amount of type inference tells one
from a duration.

Where several timestamp columns exist, the axis is the one with the most distinct values: that is
the one moving per event rather than per file.

## The Rill resources

`rill.yaml` names the project and lists `shield.sql` and `queries/` under `ignore_paths`, since
Rill would otherwise read every `.sql` file as a model. Then three files per event type, written
beside the data:

- `models/<type>_model.yaml`, a DuckDB model that selects from the Parquet file. Not
  materialised: the file is already the fast form, and materialising would copy it.
- `metrics/<type>_metrics.yaml`, the metrics view with the inferred dimensions and measures, and
  the time axis when there is one.
- `dashboards/<type>_explore.yaml`, an explore over that view showing everything it defines.

Measures use `TRY_CAST(column AS DOUBLE)` rather than a cast, so one unparseable value does not
take down a measure.

## What is not here

No credential storage, no filtering or redaction of log content, and no Real-Time Event
Monitoring. This reads `EventLogFile`, which is the batch side of event monitoring, and event log
files appear some time after the events they describe.
