# 0008: An MCP server answers questions over the extraction, read only and capped

- Status: Accepted
- Date: 2026-09-09

## Context

The extraction is a database ([0007](0007-parquet-tables-and-sql.md)): one Parquet table per
event type, a views script, and a directory of ready-made questions in SQL. The people who
bring the questions are administrators and security people, and many of them would rather ask
than write SQL. Assistants that can ask on their behalf speak the Model Context Protocol, and a
stdio MCP server is a process the client starts and talks to over a pipe.

Two servers already exist that almost fit. Salesforce ships a DX MCP server for the `sf` CLI,
but its tools come from a fixed list of internal providers compiled into it, with the provider
API marked for internal use only, so there is no route for a plugin to add tools to it. Generic
DuckDB servers run SQL over any file, but know nothing of these tables: not which columns group
rows and which identify them, which the profiling of
[0002](0002-infer-column-roles-from-data.md) already works out, and not the questions in
`queries/`.

The tables are unredacted production logs: user ids, addresses, URIs and query text. Everything
else in this tool keeps that data on the machine it was extracted to. An MCP server is the one
place the data is handed to a model, which usually runs elsewhere, and a SQL endpoint with no
guard would also let the model read any file on the machine, since a `SELECT` can call
`read_csv` on any path.

## Decision

A fourth command, `sf shield events mcp`, serves an extraction directory over stdio. It opens
every Parquet file as a view, the way `shield.sql` does, and offers five tools: list the tables
with their row counts, describe a table, list the ready-made questions, run one, and run a
`SELECT`. A description gives each column's type and its role from the same profiling that
builds the dashboards, and shows no value.

The server is read only three ways, all enforced by DuckDB rather than by inspecting text:

- Only a single `SELECT` runs. Every statement goes through `json_serialize_sql` first, which
  serialises a `SELECT` and refuses anything else with an error, so `COPY`, `CREATE`, `INSTALL`
  and `SET` fail before they run, whatever they look like.
- Only the extraction directory can be read. After the views are created, `allowed_directories`
  is set to that directory, `enable_external_access` is turned off, and the configuration is
  locked, so a `SELECT` over a path outside the directory fails with a permission error and a
  `SET` that tries to lift it fails too.
- Every answer is capped at a number of rows, 200 unless `--row-limit` says otherwise, and the
  answer says when it was cut. The read stops once the limit is passed rather than fetching the
  rest.

The server never touches an org. It reads a directory, and the directory is what the reader
chose to extract. The DuckDB behind it runs under the same 256 MB memory limit as the extraction.

## Consequences

- The plugin depends on `@modelcontextprotocol/sdk` and `zod`. The server is built in
  `events/mcp.ts`, which knows nothing of the CLI, so a test connects a client to it through an
  in-memory pipe and exercises the confinement the way an attacker would: `COPY` to a file, a
  `SET` on the guard, a `SELECT` over a file outside the directory.
- The row cap is a guard on volume, not a redaction. A client can page with `OFFSET`, and the
  server's own instructions say to aggregate rather than list. The command's help says the rest:
  point it at an extraction you would be willing to paste into that model.
- Stdio only. An HTTP transport would mean a port with production logs behind it; stdio ties
  the server to the session of whoever started it and ends with it.
- The `--json` flag is off for this command, since stdout is the protocol. Anything meant for a
  person goes to stderr.
- The views use absolute paths, unlike `shield.sql`, because the server does not change into the
  directory. The two ways of opening the directory stay independent, as
  [0004](0004-rill-project-beside-the-data.md) asks.
