-- REST calls that failed, by resource, status and client.
-- Needs: RestApi
SELECT
  STATUS_CODE,
  coalesce(ENTITY_NAME, URI) AS resource,
  coalesce(CLIENT_NAME, 'unknown') AS client,
  count(*) AS failures,
  count(DISTINCT USER_ID) AS users,
  any_value(EXCEPTION_MESSAGE) AS example_message
FROM RestApi
WHERE TRY_CAST(STATUS_CODE AS INTEGER) >= 400
GROUP BY ALL
ORDER BY failures DESC
LIMIT 50;
