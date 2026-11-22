-- Read-only production statistics gap triage.
-- An empty statistics_json field is not proof of a failed ingestion.
-- Status is historical and can be stale; never infer a match has not started from NS alone.
-- Raw app-format fixture JSON containing only teams/goals is NOT statistics evidence.
WITH rows AS (
  SELECT league_name, source, fixture_id, kickoff, status,
    CASE WHEN statistics_json IS NULL OR length(trim(statistics_json)) <= 2 THEN 1 ELSE 0 END AS missing_stats,
    CASE WHEN json_valid(raw_json) THEN 1 ELSE 0 END AS valid_raw,
    CASE WHEN json_valid(raw_json)
       THEN json_type(raw_json, '$.statistics') END AS raw_statistics_type,
    CASE WHEN json_valid(raw_json)
       THEN json_type(raw_json, '$.response') END AS raw_response_type
  FROM matches
)
SELECT league_name, source, status,
  CASE
    WHEN status IN ('NS','TBD') THEN 'scheduled_or_stale_status_verify_provider'
    WHEN status IN ('FT','AET','PEN') AND valid_raw=0 THEN 'final_invalid_raw_verify_source'
    WHEN status IN ('FT','AET','PEN') AND raw_statistics_type IS NULL AND raw_response_type IS NULL
      THEN 'final_no_statistics_in_raw_verify_source'
    WHEN status IN ('FT','AET','PEN') THEN 'final_raw_payload_requires_schema_review'
    ELSE 'other_status_verify_provider'
  END AS triage_category,
  COUNT(*) AS records
FROM rows
WHERE missing_stats=1
GROUP BY league_name, source, status, triage_category
ORDER BY records DESC, league_name, source, status;
