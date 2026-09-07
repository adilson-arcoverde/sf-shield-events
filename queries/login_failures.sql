-- Failed logins by user and source address, with the window they happened in.
-- Only LOGIN_ERROR_* statuses are failures: a challenge or a second-factor prompt is a step of
-- a login that then succeeds or fails on its own row.
-- Needs: Login
SELECT
  USER_NAME,
  SOURCE_IP,
  COUNTRY_CODE,
  LOGIN_STATUS,
  count(*) AS attempts,
  min(TIMESTAMP_DERIVED) AS first_seen,
  max(TIMESTAMP_DERIVED) AS last_seen
FROM Login
WHERE LOGIN_STATUS LIKE 'LOGIN_ERROR%'
GROUP BY ALL
ORDER BY attempts DESC, last_seen DESC
LIMIT 100;
