# 0007: The deliverable is Parquet tables and SQL; dashboards are optional

- Status: Accepted
- Date: 2026-09-08

## Context

The audience is Salesforce administrators and security people, and the questions they bring
are concrete: which integration is burning the API limit, which Apex entry point got slower this
week, who ran a report at two in the morning. Each of those is a few lines of SQL over one event
type. None of them is answered by a dashboard that names no column.

That is the tension in this tool. [0002](0002-infer-column-roles-from-data.md) forbids hardcoded
event type and column names, and it is right to: an org carries types this tool has never seen
and the extraction must survive them. But a dashboard is an opinion about what matters, and a
generator with no opinion can only produce every dimension and every measure of every column and
leave the reader to pick. Over a real org that is 55 dimensions and 61 measures for one event
type, which is a column list with a user interface. The opinion has to live somewhere, and it
cannot live in the extractor.

Three measurements over a real extraction, 34 event types and 98 MB from a Shield sandbox:

- The largest table, 265,152 rows, is 36.6 MB as CSV and 1.6 MB as Parquet, 22 times smaller.
  A real question over it takes 0.68 s from the CSV and 0.03 s from the Parquet. In the
  production org of [0006](0006-stream-the-download.md), where one day of one type reaches
  910 MB, thirty days are 27 GB of CSV against about 1.2 GB of Parquet.
- Rill takes five seconds to reconcile a table with one row. Its models copy every table into a
  database of their own when materialised, and it is a fourth thing to install after the `sf`
  CLI, the plugin and, inside Rill, DuckDB. Its resource schema moves between releases and the
  plugin has no test that the YAML it writes opens in a given one.
- DuckDB, which Rill already carries, answers the questions on its own and reads Parquet
  directly. A DuckDB database file, though, is bound to the storage format of the version that
  wrote it, and the version inside a plugin is not the version on the reader's machine.

## Decision

The output of `extract` is a queryable directory: one typed Parquet file per event type, a
`shield.sql` that opens each as a view, and a `queries/` directory of ready-made SQL, one file
per question. DuckDB is embedded in the plugin (`@duckdb/node-api`) to write the Parquet, so the
reader installs nothing to get the tables, and needs only a DuckDB client, of any version, to
ask questions of them.

The Parquet is typed by DuckDB reading the whole CSV before deciding (`sample_size=-1`), so every
row fits its column's type and none is dropped; the row count is then checked against what was
streamed. The CSV is the intermediate and is deleted on success.

A column gets a type only when the type loses nothing: a whole number, a date, a timestamp, a
boolean. Everything else stays text as the org wrote it. DOUBLE is excluded on purpose. Salesforce
packs some timestamps as digits with three decimals, and `20260907120001.001` as a double reads
back as `20260907120001.0`, the millisecond gone; a decimal type keeps it but turns the key
prefix `001` into `1`. A version number such as `63.0` is a label and stays text too. Whoever
aggregates a text column casts, and the ready-made queries and the Rill measures already do.

The ready-made queries are where the opinion lives. They name event types and columns, which is
exactly what the extractor and the generator may not do, and they are plain SQL files so that
anyone can read, edit or add one. A query over an event type the org lacks fails with "table not
found", which is the correct answer.

`rill` remains as an optional front end over the same Parquet files, for the reader who wants to
click rather than type. Its models are not materialised, because a Parquet file is already the
fast form. It keeps the inference of [0002](0002-infer-column-roles-from-data.md), which is what
lets it work on a type nobody wrote a query for.

## Consequences

- The plugin carries a native dependency. `@duckdb/node-api` with its platform binding is about
  115 MB installed on macOS arm64, and `sf plugins install` pulls it. That is the price of the
  reader not having to install DuckDB to get tables, and it is paid once.
- `queries/` is the documented exception to "no hardcoded names", and the only one. A query is
  tested against a real org's columns when it is written; a column Salesforce renames breaks
  that query and no other part of the tool.
- A full extraction of that org, 464,031 rows, takes 95 seconds with four types downloading at once,
  against 4m36s one at a time, and leaves 6 MB of tables. DuckDB runs under a 256 MB memory limit,
  measured on a 920 MB CSV at a peak of 460 MB against 2.45 GB without it, so memory stays in
  proportion to the limit and not to the file.
- Integer columns aggregate without a cast; decimal ones need `TRY_CAST`, which is the price of
  never rounding a value the org wrote.
- Rill sees every `.sql` file in a project as a model, so `rill.yaml` lists `shield.sql` and
  `queries/` under `ignore_paths`. The two ways of opening the directory do not see each other.
- Rill is optional and says so in its own help text. Dropping it entirely would remove the
  inference layer's only consumer, and the inference is what gives an unknown type a dashboard,
  so it stays. The YAML the tool writes is a contract with whatever Rill is installed, and the
  only way to hold a contract with a moving target is to hand it a project: a test writes one
  over a one-row table and runs `rill validate` on it, and is skipped where there is no Rill.
- The packed plugin installs into an empty directory with the platform binding resolved, through
  the same `npm install --omit dev` that `sf plugins install` runs, and the installed copy runs
  `discover` against an org. Behind a corporate proxy that install honours npm's own proxy
  configuration (`HTTPS_PROXY`, or `npm config set proxy`), like any other plugin.
- The extraction directory is the project ([0004](0004-rill-project-beside-the-data.md)), and it
  opens three ways: `duckdb -init shield.sql`, `rill start`, and `sf shield events mcp`.
