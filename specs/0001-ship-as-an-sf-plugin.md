# 0001: Ship as an `sf` plugin

- Status: Accepted
- Date: 2026-09-07

## Context

The audience is Salesforce administrators and security people. They already have the `sf` CLI,
and they already have their orgs authenticated in it. What they do not necessarily have is a
second runtime, a second package manager, or the patience for either.

A standalone tool has to handle its own authentication: obtain a token, keep it with the
instance URL, remember which org was used last, offer a `client_credentials` path for the cases
where a user login is not available. Every one of those is a place to store a secret and a
thing to get wrong, and none of them is the problem this tool exists to solve.

## Decision

An `sf` plugin in TypeScript: `sf shield events discover`, `extract`, `rill` and `mcp`.

## Consequences

- There is no authentication layer. `Flags.requiredOrg()` hands over a live connection, so
  there is no token to store, no instance URL to track, no alias to remember and no `.env`.
- Installation is `sf plugins install` from npm, which carries the compiled output; a clone of
  the repository is for working on the plugin. An unsigned plugin makes the CLI warn once that
  it cannot verify the publisher, which is accepted.
- The command name is the directory path, so `src/commands/shield/events/extract.ts` is
  `sf shield events extract` with nothing to declare but the topic.
- Tests run on the Node test runner against the TypeScript sources, with no framework and no
  build step.
- The runtime is the one the `sf` CLI bundles, so the Node version is never the reader's
  problem.
