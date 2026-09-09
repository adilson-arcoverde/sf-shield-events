# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the numbering
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html), where the public surface is
the three commands and their flags.

## [0.3.0] - 2026-09-09

### Added

- `sf shield events extract` without `--event-type`, in a terminal, asks: which interval if the
  org keeps hourly files, which event types from a list that shows each one's file count, size
  and days, and the first and last day, proposed as what the chosen types cover. Before
  downloading it prints the command line that runs the same extraction without a question.
  Outside a terminal, with `--json` or with `--no-prompt`, the flag is still required. See
  [specs/0009](specs/0009-extract-asks-when-not-told.md).

### Changed

- `sf shield events discover` shows each event type's total size and the first and last day it
  covers, and lists hourly files on their own lines in an org that keeps them. Its JSON gains
  `interval`, `bytes`, `earliest` and `latest`.
- The package ships `lib/src` and `queries` only, and the build empties `lib` before compiling,
  so a published version carries no compiled tests and nothing from an earlier layout.

## [0.2.0] - 2026-09-09

### Added

- `sf shield events mcp`, serving an extraction directory to a Model Context Protocol client
  over stdio: list the tables, describe a table by column type and role without showing a
  value, list and run the ready-made questions, and run a single `SELECT`. DuckDB is confined
  to the directory and locked there, anything that is not one `SELECT` is refused, and every
  answer is capped at `--row-limit` rows, 200 by default. See
  [specs/0008](specs/0008-mcp-server-over-the-extraction.md).

### Fixed

- `sf shield events extract` installed under the `sf` CLI failed after writing the tables,
  because it looked for the shipped `queries/` in the CLI's root instead of the plugin's. The
  tables and `shield.sql` were written; the queries were not, and the command reported an error.

## [0.1.0] - 2026-09-08

### Added

- `sf shield events discover`, listing the event types an org has logs for with a file count
  each, read from the org rather than from a list, sorted by name.
- `sf shield events extract`, downloading the log files for the requested event types and
  consolidating each type into one typed Parquet table on the union of the headers found. Beside
  the tables it writes `shield.sql`, which opens each as a DuckDB view, and a `queries/`
  directory of ready-made SQL questions. `--interval` chooses daily or hourly files,
  `--concurrency` how many types download at once; a failed download is retried without ever
  doubling a file's rows, and a failed type is reported after the others are written.
- `sf shield events rill`, optionally writing a Rill model, metrics view and dashboard over each
  table, with dimensions and measures inferred from the data.

### Notes

- Log files are streamed, not buffered, and the total download is reported before it starts with
  a confirmation above 500 MB. A row whose width differs from its file's header is kept on the
  columns it fills and reported, never trimmed in silence. See
  [specs/0006](specs/0006-stream-the-download.md).
- Each table is converted from the streamed CSV by the DuckDB the plugin carries, with the type
  sniffer reading the whole file so no row is dropped, only lossless types on offer so no value
  is rounded, a 256 MB memory limit so the conversion does not grow with the file, and the row
  count checked against the rows streamed. See
  [specs/0007](specs/0007-parquet-tables-and-sql.md).
- Measured over the whole catalogue of a Shield org: 34 event types, 665 files, 98 MB, streamed into
  464,031 rows in 95 seconds at a peak of 363 MB, with the tables coming to 6 MB. Every type got a
  time axis and a dashboard, including ones the tool had never seen, no file delivered a column the
  org had not declared, and Rill reconciled all 102 resources without a warning.
- Measured on a production org, one day of one event type is a 412 MB file streamed into
  1,012,250 rows; a 381 MB local file streams in 23 seconds at a peak of 175 MB.

[0.3.0]: https://github.com/adilson-arcoverde/sf-shield-events/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/adilson-arcoverde/sf-shield-events/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/adilson-arcoverde/sf-shield-events/releases/tag/v0.1.0
