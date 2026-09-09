# 0003: Consolidate on the union of columns

- Status: Accepted
- Date: 2026-09-07

## Context

An extraction usually spans several days, so several log files per event type, and Salesforce
changes the columns of an event type between API versions. A consolidated table that takes its
columns from the first file therefore drops, without a word, whatever the later files carry and
the first does not.

It is the kind of loss nobody notices: the output looks complete, and the missing column is
missing everywhere.

## Decision

Take the union of the columns, so every file contributes its shape and every row keeps its own
values, gaining empty strings for columns it never had.

The union is read from `LogFileFieldNames`, which the query that finds the files already
returns. Reading it from the files themselves is not possible: they are streamed and written as
they arrive, and a stream cannot wait to see the last file before writing the first row
([0006](0006-stream-the-download.md) has the measurements that forced that).

## Consequences

- A wide table with holes, which is what a reader of consolidated logs expects and what DuckDB
  and Rill handle without complaint.
- The order of columns follows first appearance across the declarations, since there is no
  schema to follow.
- The guarantee rests on metadata being truthful. When a file carries a column the org did
  not declare, the writer would drop it, so the first row of every file is checked and any
  undeclared column is reported by name.
- Two tests hold this: one that the union survives a shape change, and one that an undeclared
  column is named rather than lost.
