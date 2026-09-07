-- Which client is burning the API limit, per day.
-- Needs: ApiTotalUsage
SELECT
  LOG_DATE,
  coalesce(CONNECTED_APP_NAME, CLIENT_NAME, 'unknown') AS client,
  USER_NAME,
  count(*) AS calls,
  sum(TRY_CAST(COUNTS_AGAINST_API_LIMIT AS BIGINT)) AS calls_against_limit
FROM ApiTotalUsage
GROUP BY ALL
ORDER BY calls_against_limit DESC NULLS LAST, LOG_DATE DESC
LIMIT 50;
