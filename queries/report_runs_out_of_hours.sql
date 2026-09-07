-- Who ran a report outside working hours, and how many rows it returned.
-- Hours are in the session time zone: SET TimeZone first if the org is elsewhere.
-- Needs: AsyncReportRun. The ReportExport type, when the org has it, answers the same
-- question for exports; swap the table name.
SELECT
  TIMESTAMP_DERIVED AS ran_at,
  USER_ID,
  REPORT_ID,
  TRY_CAST(ROW_COUNT AS BIGINT) AS row_count,
  CLIENT_IP
FROM AsyncReportRun
WHERE hour(TIMESTAMP_DERIVED) NOT BETWEEN 7 AND 20
   OR dayofweek(TIMESTAMP_DERIVED) IN (0, 6)
ORDER BY row_count DESC NULLS LAST, ran_at DESC
LIMIT 100;
