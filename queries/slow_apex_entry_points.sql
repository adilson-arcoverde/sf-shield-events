-- Which Apex entry point got slower in the last seven days, against the seven before.
-- Anchored on the newest day in the table, so it works on an old extraction too.
-- Needs: ApexExecution
WITH newest AS (SELECT max(LOG_DATE) AS d FROM ApexExecution),
runs AS (
  SELECT
    ENTRY_POINT,
    CASE WHEN LOG_DATE > (SELECT d FROM newest) - INTERVAL 7 DAY THEN 'this_week' ELSE 'last_week' END AS period,
    TRY_CAST(RUN_TIME AS DOUBLE) AS run_time
  FROM ApexExecution
  WHERE LOG_DATE > (SELECT d FROM newest) - INTERVAL 14 DAY
)
SELECT
  ENTRY_POINT,
  count(*) FILTER (WHERE period = 'this_week') AS runs_this_week,
  round(avg(run_time) FILTER (WHERE period = 'last_week')) AS avg_ms_last_week,
  round(avg(run_time) FILTER (WHERE period = 'this_week')) AS avg_ms_this_week,
  round(avg(run_time) FILTER (WHERE period = 'this_week') - avg(run_time) FILTER (WHERE period = 'last_week')) AS delta_ms
FROM runs
GROUP BY ENTRY_POINT
HAVING runs_this_week > 0
ORDER BY delta_ms DESC NULLS LAST
LIMIT 30;
