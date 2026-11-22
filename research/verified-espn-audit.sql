-- READ-ONLY audit: ESPN records with provider-confirmed final status and matching scores.
-- Run against a read-only export or via SELECT-only D1 access.
-- IMPORTANT: non-ESPN providers require separate source-specific evidence.
SELECT
 league_name,
 COUNT(*) AS confirmed_final_score_matches,
 SUM(CASE WHEN julianday(kickoff) > julianday('now') THEN 1 ELSE 0 END) AS future_dated
FROM matches
WHERE lower(source) = 'espn'
  AND json_valid(raw_json)
  AND json_extract(raw_json,'$.competitions[0].status.type.completed') = 1
  AND json_extract(raw_json,'$.competitions[0].status.type.state') = 'post'
  AND fixture_id LIKE 'espn-%-' || CAST(json_extract(raw_json,'$.id') AS TEXT)
  AND CAST(json_extract(raw_json,'$.id') AS TEXT) =
      substr(fixture_id, length(fixture_id) - length(CAST(json_extract(raw_json,'$.id') AS TEXT)) + 1)
  AND json_type(raw_json,'$.competitions[0].competitors[0].score') IN ('text','integer')
  AND json_type(raw_json,'$.competitions[0].competitors[1].score') IN ('text','integer')
  AND trim(CAST(json_extract(raw_json,'$.competitions[0].competitors[0].score') AS TEXT)) NOT GLOB '*[^0-9]*'
  AND trim(CAST(json_extract(raw_json,'$.competitions[0].competitors[1].score') AS TEXT)) NOT GLOB '*[^0-9]*'
  AND length(trim(CAST(json_extract(raw_json,'$.competitions[0].competitors[0].score') AS TEXT))) > 0
  AND length(trim(CAST(json_extract(raw_json,'$.competitions[0].competitors[1].score') AS TEXT))) > 0
  AND CAST(json_extract(raw_json,'$.competitions[0].competitors[0].score') AS INTEGER) >= 0
  AND CAST(json_extract(raw_json,'$.competitions[0].competitors[1].score') AS INTEGER) >= 0
  AND CAST(home_team_id AS TEXT) = CAST(json_extract(raw_json,'$.competitions[0].competitors[0].id') AS TEXT)
  AND CAST(away_team_id AS TEXT) = CAST(json_extract(raw_json,'$.competitions[0].competitors[1].id') AS TEXT)
  AND home_goals = CAST(json_extract(raw_json,'$.competitions[0].competitors[0].score') AS INTEGER)
  AND away_goals = CAST(json_extract(raw_json,'$.competitions[0].competitors[1].score') AS INTEGER)
  AND julianday(kickoff) <= julianday('now')
  AND json_extract(raw_json,'$.competitions[0].competitors[0].homeAway')='home'
  AND json_extract(raw_json,'$.competitions[0].competitors[1].homeAway')='away'
GROUP BY league_name
ORDER BY confirmed_final_score_matches DESC;
