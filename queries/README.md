# Ready-made questions

Each file answers one question over the tables `extract` wrote. They are opinionated on
purpose: the extractor and the dashboard generator name no EventType and no column, so that an
org can carry types this tool has never seen, and these files are where the opinion lives
instead. A query that names an EventType the org does not have fails with "table not found",
which is the correct answer.

Run them from the output directory:

```
cd output
duckdb -init shield.sql
.read queries/api_usage_by_client.sql
```

Times are `TIMESTAMP_DERIVED`, which Salesforce writes in UTC. DuckDB shows them in the session
time zone; `SET TimeZone = 'America/Sao_Paulo';` first if the org lives somewhere else.
