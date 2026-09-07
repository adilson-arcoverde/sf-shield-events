# 0004: The output directory is the project

- Status: Accepted
- Date: 2026-09-07

## Context

Everything that reads the extracted tables does so by path: the `shield.sql` views, the
ready-made queries, and the Rill model SQL. Those paths have to resolve on whatever machine
opens the directory.

An absolute path works here and nowhere else. A copy of the tables into a separate project
directory works everywhere and doubles the disk cost of a multi-gigabyte extraction.

## Decision

Write everything into the directory that holds the tables, and refer to the tables by relative
name: `shield.sql` and `queries/` from `extract`, and `rill.yaml`, `models/`, `metrics/` and
`dashboards/` from `rill`.

## Consequences

- `cd output && duckdb -init shield.sql` works, `rill start output` works, and so does moving or
  sharing that one directory.
- The script and the models only resolve from inside the directory, and say so.
- The extraction directory is a project as well as data, which the `.gitignore` accounts for:
  the generated files are ignored along with the tables.
- Generating twice overwrites the generated files, which is the intended behaviour, and any
  dashboard edit made inside Rill is lost. Anyone customising a dashboard should copy it out
  first. `shield.sql` is rebuilt over every table present, not only the ones a run wrote, so
  extractions accumulate.
