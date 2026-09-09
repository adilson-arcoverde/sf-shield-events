# 0006: Stream the download, and take the union from metadata

- Status: Accepted
- Date: 2026-09-08

## Context

The obvious way to read a log file is to download the body into a string and parse it. That
works against fixtures and fails against an org.

Measured on a client production org with Shield: 5,649 files, average 57 MB, largest 910 MB.
The file that a one day extraction matches can be 412 MB. A JavaScript string tops out near
512 MB in V8, so the largest file in that org cannot be held at all, and one that fits still
needs the text and the parsed rows in the heap together.

The failure is worse than an error. A download that returns nothing usable parses into no
records, and the command then writes a CSV containing one header line and reports success. A
tool that silently produces an empty extraction is more dangerous than one that crashes.

## Decision

Stream. The body is fetched with `fetch`, using the connection's own credentials because the
jsforce client buffers a response, and piped through an incremental CSV parser into an
incremental writer. Nothing holds a file.

The union of columns comes from `LogFileFieldNames`, which the query already returns for
every matching file. A stream cannot wait to see the last file before writing the first row, so
the shape has to be known before the first byte arrives. The metadata gives it.

Column profiling reads a sample of 20,000 rows rather than the whole table, for the same reason.

EventTypes download in parallel, four at a time unless `--concurrency` says otherwise, while the
files of one type stay in order because they append to one stream. A type that fails does not stop
the others: its error is kept and reported when everything else has been written, so a rerun names
only what is missing. A download that fails is tried again, up to three times, and an expired
session is refreshed rather than retried. Before every retry the table is cut back to the byte where
that file began, so a file is in the table whole or not at all and a retry cannot double its rows.
An extraction of thirty days runs for hours, past the life of a session, and a 900 MB body gives a
connection plenty of time to drop; both are ordinary and neither should cost the files already
written.

The streamed CSV is an intermediate. Once a table is complete it is converted to Parquet, checked
row for row, and the CSV is deleted; [0007](0007-parquet-tables-and-sql.md) has that decision.
The conversion runs under a DuckDB memory limit of 256 MB for the same reason the download
streams: left to its default, DuckDB takes most of the machine, and a 920 MB CSV peaked at
2.45 GB, which would have put memory back in proportion to file size. At the limit it peaks at
460 MB and runs faster.

## Consequences

- Measured on a 381 MB file with 1.3 million rows: 23 seconds, peak RSS 175 MB. Memory does not
  follow file size.
- The union of [0003](0003-union-of-headers.md) comes from what the org declares rather than
  from what the files reveal. That record says so; this one has the reason.
- Trusting metadata introduces a new failure. If a file carries a column the org did not declare,
  the writer drops it, so the tool checks the first row of every file and warns by name when that
  happens rather than losing it quietly.
- The command reports the total download before starting and asks for confirmation above
  500 MB, because a one day range can mean half a gigabyte and nobody should learn that from
  their bandwidth bill. `--no-prompt` skips the question.
- Every table costs one more pass, the conversion. A conversion that lost rows would be exactly
  the silent failure above in a new place, so its row count is checked against the number of
  rows streamed, and a mismatch keeps the CSV and fails the command.
- A failure in the middle of a file costs that file's attempt, not the extraction. The truncate
  before a retry is what makes the row count trustworthy. The first run against a real org with
  retries in place hit one dropped connection, on `Login 2026-07-05`; the retry took it and the
  table closed with the right count.
- The CSV parser is asked for arrays, not objects, so a row wider or narrower than the file's own
  header is seen. Asked for objects, it would trim the wide row and pad the narrow one without a
  word. Such rows are kept on the columns they fill and counted, and the count is reported with
  the first offending row.
- Parallel types do not change the memory profile: conversions run one after another on the one
  DuckDB, so its limit is the limit of the run.
- Only the daily files, or only the hourly ones, are ever read in one extraction (`--interval`).
  An org with hourly files enabled keeps both for the same day and the daily file contains every
  row of the hourly ones, so reading both would count every event twice.
