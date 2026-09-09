# Decision records

Why this tool is shaped the way it is. One record per decision, numbered, and kept current: when
a decision changes, its record is rewritten to state what holds now, as if it had always said
so. A decision that is genuinely new gets its own record instead, and the ones it touches point
at it.

Reading a record should tell you how the tool works today. Alternatives belong in the Context,
where they explain the choice; the git history keeps every version anyway.

| #                                            | Decision                                                            | Status   |
| -------------------------------------------- | ------------------------------------------------------------------- | -------- |
| [0001](0001-ship-as-an-sf-plugin.md)         | Ship as an `sf` plugin                                              | Accepted |
| [0002](0002-infer-column-roles-from-data.md) | Infer what a column is for from the data, not from its name         | Accepted |
| [0003](0003-union-of-headers.md)             | Consolidate on the union of columns                                 | Accepted |
| [0004](0004-rill-project-beside-the-data.md) | The output directory is the project                                 | Accepted |
| [0005](0005-apache-2-0.md)                   | Publish under Apache 2.0                                            | Accepted |
| [0006](0006-stream-the-download.md)          | Stream the download, and take the union from metadata               | Accepted |
| [0007](0007-parquet-tables-and-sql.md)       | The deliverable is Parquet tables and SQL; dashboards are optional  | Accepted |
| [0008](0008-mcp-server-over-the-extraction.md) | An MCP server answers questions over the extraction, read-only and capped | Accepted |
| [0009](0009-extract-asks-when-not-told.md) | `extract` asks when not told, and prints the command it would have run | Accepted |

The drafting and the code were done with an AI assistant; the decisions are the author's. It is
said here once rather than on each record.
