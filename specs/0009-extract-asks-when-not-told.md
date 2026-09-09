# 0009: `extract` asks when not told, and prints the command it would have run

- Status: Accepted
- Date: 2026-09-09

## Context

`extract` needs to know which event types to download, and until now it refused to run without
`--event-type`. The reader was expected to run `discover` first, read a list of names and file
counts, decide, and type the flags. That is the right shape for a script and the wrong shape for
the first time: the names mean little until one knows what each costs, the file count says
nothing about size, and the date range the org holds is not shown anywhere, so the first
extraction is either everything or a guess.

The same question could be answered by a web page, and the case for one is that a page can show
a list with checkboxes. The case against is everything a page brings with it: a second process,
a port, either its own authentication or the `sf` session behind that port, a second place to
keep in step with every flag, and a tool that stops working over SSH. The terminal already has
checkboxes. `@salesforce/sf-plugins-core` brings the `@inquirer` family in for its own
confirmation prompt, and the list, select and input prompts are the same family.

One query answers what a guide needs to show. `EventLogFile` aggregates by `EventType` and
`Interval`, and `COUNT`, `SUM(LogFileLength)`, `MIN(LogDate)` and `MAX(LogDate)` come back in
one round trip, measured against a Shield org with 34 types. SOQL reserves `first` and `last`,
so the date aliases are `earliest` and `latest`.

## Decision

Without `--event-type`, and only when there is someone to ask, `extract` asks. It runs the
inventory query, and then in the order the answers depend on each other: the interval, only if
the org keeps hourly files, since otherwise there is nothing to choose; the event types, as a
list where every line says how many files, how many bytes and which days choosing it costs;
then the first and last day, proposed as the span the chosen types actually cover, so accepting
the defaults means "all of it".

Before downloading, the command prints the command line that would run the same extraction
without a question: the org as the reader named it, one `-e` per type, the dates, and any flag
that left its default, ending in `--no-prompt`. That line is the point of the guide. Whoever
answered once can paste it into a script, and the questions have taught the flags.

"Someone to ask" means both stdin and stdout are a terminal, `--json` is off and `--no-prompt`
is off. Anything else with no `--event-type` fails the way it always did, with an error that
names the flag. A pipeline never sees a prompt.

`discover` reads the same query and now shows, per type, the file count, the size and the days,
with the interval on its own column only in an org that has more than one. It is the same
inventory the guide offers, for the reader who wants to look without extracting.

## Consequences

- `--event-type` is no longer required by oclif, so the command decides for itself whether the
  absence is a question or an error. The check lives in one method, `canAsk`, and the guide in
  another, `ask`; the list lines, the date bounds and the printed command line are pure
  functions in `events/inventory.ts`, tested without an org or a terminal.
- Three small dependencies: `@inquirer/checkbox`, `@inquirer/input` and `@inquirer/select`,
  from the family the plugin already loads.
- The printed command ends in `--no-prompt`, which also skips the confirmation above 500 MB.
  The reader saw the sizes on every line of the list and the total before the download, so the
  decision the confirmation asks for has been made; the line records it.
- The JSON of `discover` carries more fields than before, `interval`, `bytes`, `earliest` and
  `latest`, and an org with hourly files lists a type once per interval.
- Prompts are exercised by hand and by an `expect` script in a pseudo-terminal, not by the test
  suite; what the suite covers is everything the prompts are built from.
