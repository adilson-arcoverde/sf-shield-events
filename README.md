# sf-shield-events

[![CI](https://github.com/adilson-arcoverde/sf-shield-events/actions/workflows/ci.yml/badge.svg)](https://github.com/adilson-arcoverde/sf-shield-events/actions/workflows/ci.yml)

An `sf` CLI plugin that pulls Salesforce Shield Event Monitoring logs out of an org into a
directory of Parquet tables you can ask questions of with [DuckDB](https://duckdb.org/), with
the usual questions already written. Optionally, a [Rill](https://www.rilldata.com/) project
over the same tables.

```bash
sf shield events discover --target-org my-org
sf shield events extract  --target-org my-org --event-type ApexExecution --event-type Login
cd output && duckdb -init shield.sql      # then, at the DuckDB prompt:
.read queries/slow_apex_entry_points.sql
```

Two commands and a database: find out what the org has, download it, ask. A third command,
optional, puts dashboards over the same tables.

## Status

Validated end to end against a Shield org, the whole catalogue: 34 event types, 665 log files,
98 MB, streamed into 464,031 rows across 34 typed Parquet tables in 95 seconds at a peak of
363 MB of memory. The tables come to 6 MB. Every one of the six ready-made queries ran, and
Rill reconciled the 102 resources of the optional project with no warnings.

Also measured, on a production org: one day of one event type is a 412 MB log file, and the
largest seen is 910 MB, which is why nothing here buffers a download
([specs/0006](specs/0006-stream-the-download.md)).

## Why this exists

Shield Event Monitoring answers questions worth asking. Which integration is burning the API
limit, which Apex entry point got slower this week, who exported a report at two in the morning.
The data is there, in `EventLogFile`, and getting to it is the problem: one CSV per event type
per day, delivered as a blob you have to fetch record by record, with columns that differ by
event type and change between API versions.

So most people either buy a product for it, or write the same throwaway script again. This is
that script, written once, with the parts that usually rot replaced by inference, and the
questions people actually ask kept as SQL files you can read and change
([specs/0007](specs/0007-parquet-tables-and-sql.md)).

## Installing it

```bash
sf plugins install sf-shield-events
```

The CLI will say it cannot verify the publisher, because the plugin is not signed by Salesforce.
That is expected. The plugin carries DuckDB as a native dependency, about 115 MB once installed;
behind a corporate proxy the install honours npm's proxy settings (`HTTPS_PROXY`, or
`npm config set proxy`) like any other plugin.

Requires Node 22.6 or later, which the `sf` CLI already bundles. DuckDB comes with the plugin,
so the tables are written without installing anything else; to ask questions of them you want
the [DuckDB CLI](https://duckdb.org/docs/installation/), any version. Only the optional
dashboards need [Rill](https://docs.rilldata.com/home/install).

## What the commands do

### `sf shield events discover`

Asks the org which event types it has logs for, and how many files each one has. No list of
event types is built into this tool: the answer depends on the edition, on which Shield features
are licensed, and on what happened in the org inside the retention window.

An org with Shield or the Event Monitoring add-on generates event log files by default and
keeps them for thirty days. A Developer Edition or trial org has to opt in first, under Setup >
Event Monitoring Settings > Generate event log files, and keeps one day; without the opt-in the
org has no files at all, which `discover` reports as none rather than as an error.

### `sf shield events extract`

Downloads the log files for the event types you name and writes one Parquet table per type,
then makes the directory a database: `shield.sql` opens every table as a view, and `queries/`
holds one SQL file per question people bring to event logs.

The columns of a table are the union of what the org declares across the matching files, not
the columns of the first one. Salesforce changes them between API versions, and an extraction
spanning that change should not lose the difference.

Files are streamed rather than buffered, because they are large: in a busy production org they
average 57 MB and the largest measured was 910 MB. The command reports the total download before
it starts and asks before anything over 500 MB, since a single day of one busy event type can
mean half a gigabyte ([specs/0006](specs/0006-stream-the-download.md)). A download that fails is
retried, an expired session is refreshed, and a retry never doubles a file's rows. Each table is
then typed and converted by DuckDB under a fixed memory limit, and the conversion is checked row
for row: a table that lost a row fails the command rather than reporting success.

Types are given only where nothing is lost: whole numbers, dates, timestamps, booleans. A
packed Salesforce timestamp, a version number or a key prefix stays text exactly as the org
wrote it ([specs/0007](specs/0007-parquet-tables-and-sql.md)).

The flags: `--event-type` (`-e`), repeated for each type; `--start-date` and `--end-date` as
`YYYY-MM-DD`, both inclusive; `--output-dir`, `output` by default; `--no-prompt` to skip the
question above 500 MB; `--interval`, `Daily` by default or `Hourly`, in an org that keeps both,
because reading both would count every event twice; `--concurrency`, how many event types
download at once, four by default, with the files of one type always arriving in order. A type
that fails is reported at the end, after the others have been written, and `--json` returns the
tables written as data.

```bash
sf shield events extract -o my-org -e ApexExecution --start-date 2026-09-01 --end-date 2026-09-07
cd output
duckdb -init shield.sql
.read queries/slow_apex_entry_points.sql
```

The six questions shipped, one file each under `queries/`:

| File                           | Question                                                      | Needs            |
| ------------------------------ | ------------------------------------------------------------- | ---------------- |
| `api_usage_by_client.sql`      | Which client is burning the API limit, per day                | `ApiTotalUsage`  |
| `slow_apex_entry_points.sql`   | Which Apex entry point got slower this week, against the last | `ApexExecution`  |
| `report_runs_out_of_hours.sql` | Who ran a report outside working hours, and how many rows     | `AsyncReportRun` |
| `login_failures.sql`           | Failed logins by user and source address                      | `Login`          |
| `dml_volume_by_user.sql`       | Who wrote the most rows, per day, by operation and object     | `DatabaseSave`   |
| `rest_api_errors.sql`          | REST calls that failed, by resource, status and client        | `RestApi`        |

The queries are opinionated on purpose and name real columns, which nothing else in the tool
does. Read `queries/README.md`, edit them, add your own: a later extraction adds queries it
ships that are missing and leaves the ones already there alone. A query over an event type the
org lacks fails with "table not found", which is the correct answer.

### `sf shield events rill` (optional)

Reads the tables and writes a Rill project over them: a model, a metrics view and a dashboard per
event type. Then `rill start output`. The tables are already a database without this; Rill adds
a point-and-click explorer for the reader who would rather not type SQL. `--input-dir` names the
directory, `output` by default.

What each column is for comes from the data, not from its name. A column of numbers gets a total
and an average; a column of ISO timestamps can be the time axis; a column with few distinct
values groups rows; a column with a distinct value per row gets counted instead. An event type
this tool has never seen still produces a usable dashboard, which is the whole point
([specs/0002](specs/0002-infer-column-roles-from-data.md)).

The project is written beside the tables so `rill start output` works and the directory can be
moved as one thing.

## What it does not do

It does not store credentials. The plugin borrows the connection the `sf` CLI already has, so
there is no token, no instance URL and no `.env` anywhere in it.

It does not filter or redact. What comes out of the org goes into the files, and event logs carry
user ids, URIs, query text and IP addresses. Treat the output directory the way you treat the
org: `.gitignore` covers it here, and deleting it when the analysis is done is the habit worth
having.

It does not do Real-Time Event Monitoring, the streaming platform events. This reads
`EventLogFile`, the batch side.

## Working on it

```bash
npm install
npm run check    # lint, typecheck and tests
npm run build    # both bin entrypoints load lib/, so build before running
./bin/run.js shield events discover -o my-org
```

Tests run on the Node test runner against TypeScript directly, so there is no test framework and
no build step for them. The table tests run a real DuckDB on files a few lines long, and one
test hands a generated project to `rill validate` when Rill is installed.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) describes how the pieces fit. [specs/](specs/)
records why each decision was made, with the measurements behind it.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE), and
[specs/0005](specs/0005-apache-2-0.md) for why this and not something restrictive.

Copyright 2026 Adilson Arcoverde.
