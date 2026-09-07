-- Who wrote the most rows, per day, by operation and object prefix.
-- Needs: DatabaseSave
SELECT
  LOG_DATE,
  USER_ID,
  DML_TYPE,
  KEY_PREFIX,
  count(*) AS statements,
  sum(TRY_CAST(NUM_ROWS AS BIGINT)) AS rows_written
FROM DatabaseSave
GROUP BY ALL
ORDER BY rows_written DESC NULLS LAST
LIMIT 50;
