# 0002: Infer what a column is for from the data, not from its name

- Status: Accepted
- Date: 2026-09-07

## Context

Salesforce publishes dozens of event types and each carries its own columns, which change
between API versions. The obvious generator holds lists to cope with that: column names mapped
to the aggregation each deserves, column names that can serve as a time axis, a regular
expression that groups one org's URLs into families.

Anything outside those lists gets a dashboard with a single `COUNT(*)` and no time axis, which
covers most of the event types Salesforce offers and all of the ones added after the lists are
written. A URL regular expression is worse than incomplete: it encodes the URL shape of the org
the tool was written against.

## Decision

Read the roles from the rows. A column whose values all parse as numbers is something to
aggregate. A column whose values all parse as ISO timestamps can be the time axis, and the one
with the most distinct values wins it. A column with few distinct values groups rows. A column
with a distinct value in almost every row identifies them, so it gets counted rather than
grouped. A column nobody filled is left out and reported.

Two rules are about the shape of a value rather than the name of a column, and both come from
real logs:

- A column of digits in the form `20260907120000.000` is a time, not a quantity. Salesforce
  writes some timestamps packed that way, they parse as numbers, and the total of a million
  timestamps means nothing. Such a column is kept out of the measures. It does not become the
  time axis either: DuckDB types it as a number, and Rill cannot put a number on a time axis, so
  the axis goes to an ISO column or to nothing.
- The sample is a reservoir sample drawn by DuckDB from the whole table, never its first rows. A
  log file is ordered by time, so a contiguous slice makes session keys and client addresses
  look like a handful of values when a full day holds thousands. The sample comes back as text,
  so the profiler sees what the org wrote rather than what DuckDB typed it as.

## Consequences

- An event type this tool has never seen gets a usable dashboard. A test asserts exactly that,
  using a column named `SOME_FUTURE_METRIC`.
- Every numeric column gets both a total and an average, because the data cannot say whether it
  counts things or measures them, and both are cheap.
- A numeric column with few distinct values becomes a dimension as well as a measure. A status
  code parses as a number and still describes rows, and inference alone cannot tell it from a
  duration.
- Inference is not semantics and will sometimes be wrong. A duration expressed as an integer
  count of milliseconds is indistinguishable from a quantity, and the tool will offer to sum it.
  That is a worse failure than a missing measure only if someone trusts the sum without looking.
- The sample is a reservoir, never the head of the file, and no fixture could show why. A log
  file is ordered by time, so its first rows are the first minutes of the day, and the count of
  distinct values in a contiguous slice says nothing about the file: against a real day it makes
  session keys and client addresses look like a handful of values worth grouping by. The
  reservoir reads the whole table and holds only the sample, so memory is bounded and time is
  proportional to the table.
- Numeric codes are still summed. A status code and a user agent identifier both parse as
  numbers, and `sum_status_code` is meaningless. They are also offered as dimensions, which is
  the useful role, and no rule about the shape of a value distinguishes a code from a count.
