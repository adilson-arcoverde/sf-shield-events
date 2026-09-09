# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

An `sf` CLI plugin (oclif + `@salesforce/sf-plugins-core`) that pulls Salesforce Shield
Event Monitoring logs out of an org into a directory of Parquet tables that DuckDB opens, with
ready-made SQL questions beside them, and optionally a [Rill](https://www.rilldata.com/) project
over the same tables or an MCP server that answers questions over them. Four commands:
`discover` -> `extract` -> `rill` (optional) and `mcp` (optional).

Node 22.6+, ESM (`"type": "module"`), TypeScript strict.

## Commands

```bash
npm install
npm run check          # lint + tsc --noEmit + tests. Run this before calling work done.
npm test               # node --test test/*.test.ts (runs TS directly, no build)
npm run lint           # eslint src test
npm run build          # tsc --build, emits to lib/
npm run format         # prettier over src and test

./bin/dev.js shield events discover -o my-org    # dev entrypoint, still loads lib/
./bin/run.js shield events discover -o my-org    # production entrypoint, also lib/
```

`node --test` runs the TypeScript sources through Node's type stripping, so tests need no build
step and there is no test framework beyond `node:test` + `node:assert/strict`.

**Both `bin` entrypoints need `npm run build` first.** oclif resolves commands through
`oclif.commands` in `package.json`, which is `./lib/src/commands`, so `bin/dev.js` loads the
compiled output like `bin/run.js` does and an unbuilt edit to `src/` runs as the previous build.
Only the tests read `src/` directly.

## Layout and build quirks

- `src/commands/shield/events/{discover,extract,rill,mcp}.ts`: the oclif commands. Each is a
  `default export class` extending `SfCommand`; that default export is the contract oclif loads,
  so the usual no-default-export lint rule is off.
- `src/events/{consolidate,inventory,logfiles,mcp,project,rill,stream,tables}.ts`: modules that know nothing
  about orgs or the CLI. They take rows, streams and file paths and return data. Keep them that
  way: this is where the tests are and the only reason the interesting behaviour is testable
  without an org. `tables.ts` is the DuckDB side (CSV to Parquet, sampling, the views script) and
  its tests run a real DuckDB on tiny files. `project.ts` writes the Rill project; its contract
  test runs `rill validate` and is skipped without Rill on PATH. Install Rill to exercise it.
  `mcp.ts` builds the MCP server; its test talks to it through an in-memory transport.
  `inventory.ts` is the one query behind `discover` and the guided `extract`, plus the list lines
  and the printed command line, all pure.
- `queries/*.sql`: the ready-made questions `extract` copies into the output. Shipped in the
  package (`files` in `package.json`), read at runtime from the plugin's own root
  (`this.config.plugins.get('sf-shield-events').root`), which is not `this.config.root` once the
  plugin is installed under the `sf` CLI.
- Relative imports carry a **`.ts` extension** in source (`allowImportingTsExtensions` +
  `rewriteRelativeImportExtensions`). Follow the existing style; `.js` extensions will not match.
- `rootDir` is `.`, so the build nests output as `lib/src/...`, which is why `package.json` sets
  oclif `commands` to `./lib/src/commands`. If you change `rootDir` or `outDir`, that path moves
  too.

## Invariants worth not breaking

**Never buffer a log file body.** Event log files in a real org average 57 MB and reach 910 MB,
past what a JavaScript string can hold, and a buffered download silently writes an empty CSV
while reporting success. Bodies are fetched with `fetch` (not the jsforce client, which buffers)
and piped through `csv-parse` into `csv-stringify` into a write stream. See
`src/events/stream.ts` and [specs/0006](specs/0006-stream-the-download.md).

**No event type names and no column names are hardcoded, except in `queries/`.** Event types
come from the org; the output columns come from `LogFileFieldNames` in the query; what a column
is *for* comes from profiling its values in `profileColumns`. An event type this tool has never
seen must still produce a usable table and dashboard. The one place names are allowed is the
`queries/` directory, which is where the opinion lives on purpose. See
[specs/0002](specs/0002-infer-column-roles-from-data.md) and
[specs/0007](specs/0007-parquet-tables-and-sql.md).

**A conversion that loses rows is an error, not a warning.** `convertToParquet` compares the
Parquet row count with the rows streamed and throws on a mismatch, keeping the CSV as evidence.
DuckDB's sniffer reads the whole CSV (`sample_size=-1`) so no row fails its column type; never
add `ignore_errors` to that read.

**Only lossless types, and a memory limit.** The sniffer may choose BOOLEAN, BIGINT, DATE,
TIMESTAMP, TIMESTAMPTZ or VARCHAR. Never DOUBLE, which rounds a packed timestamp, nor DECIMAL,
which turns key prefix `001` into `1`. DuckDB runs under `memory_limit = 256MB`; without it a
920 MB CSV peaked at 2.45 GB. Keep both in `src/events/tables.ts`.

**A retry never doubles rows.** `appendWithRetry` truncates the CSV to the file's start offset
before every retry. A file is in the table whole or not at all. Types run in parallel, files of
a type never do, and conversions are serialised through `convert()` so the DuckDB memory limit
is the run's limit.

**The parser returns arrays, not objects.** `appendLogFile` maps fields to the file's own header
itself so a row of the wrong width is counted and reported. Do not switch `csv-parse` back to
`columns: true`; it trims and pads in silence.

**Profile from a reservoir sample, never the head of the file.** Log files are ordered by time,
so a contiguous slice lies about cardinality. `sampleRows` gives every row an equal chance.

**The MCP server is read only, confined and capped, and all three are DuckDB's doing.** Every
statement goes through `json_serialize_sql`, which refuses anything but a single `SELECT`;
`allowed_directories`, `enable_external_access = false` and `lock_configuration` keep a `SELECT`
from reading any file outside the extraction; and answers stop at `--row-limit` rows.
`describe_table` shows no values. Do not replace the parser gate with a regular expression over
the text, and do not print anything to stdout in the `mcp` command: stdout is the protocol. See
[specs/0008](specs/0008-mcp-server-over-the-extraction.md).

**Never prompt without someone to ask.** `extract` asks only when stdin and stdout are a
terminal, `--json` is off and `--no-prompt` is off; otherwise a missing `--event-type` is an
error. Keep that check in `canAsk` and keep everything a prompt is built from in
`events/inventory.ts`, where it is tested. See
[specs/0009](specs/0009-extract-asks-when-not-told.md).

**No credentials anywhere.** `Flags.requiredOrg()` hands over a live `Connection` from the `sf`
CLI's own auth. There is no token to store, no instance URL to track, no `.env`.

## Extracted data is production data

Output is unredacted event logs: user ids, URIs, query text, IP addresses. `.gitignore` covers
`output/`, `*.csv`, `*.parquet` and the generated Rill directories (`rill.yaml`, `models/`,
`metrics/`, `dashboards/`). Never commit extracted data, and do not weaken those ignore rules.

## Conventions

- Comments explain **why**, not what, and are written in prose. Match the surrounding density:
  a non-obvious constant or a defensive choice gets a sentence or two explaining the measurement
  or failure behind it.
- Decisions live in `specs/` as numbered records (`Context` / `Decision` / `Consequences`) and are
  **kept current**: when a decision changes, rewrite its record to state what holds now, as if it
  had always said so, with no "revised", no "superseded" and no narrative of what it used to say, and
  update the table in `specs/README.md`. A genuinely new decision gets its own record.
- `docs/ARCHITECTURE.md` describes how the pieces fit; keep it in step with structural changes.
- `CHANGELOG.md` follows Keep a Changelog; the public surface is the four commands and their flags.
- Prettier: 120 columns, single quotes, semicolons, ES5 trailing commas.
