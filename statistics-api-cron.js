import {processApiCandidate} from "./statistics-api-persistence.js";
import {apiBackfillDecision} from "./statistics-api-backfill.js";

// This is a separately gated cron step. The default has no D1 writes or network requests.
// A production rollout must separately verify shared quota accounting and provider subscription.
export async function runStatisticsApiCron(env, request) {
  if (String(env?.STATISTICS_API_BACKFILL_ENABLED||"")!=="true" ||
      String(env?.API_FOOTBALL_QUOTA_VERIFIED||"")!=="true" ||
      String(env?.STATISTICS_API_SHARED_GUARD_AUDITED||"")!=="true")
    return {skipped:"disabled-until-quota-audit"};
  if (!env.DB) return {skipped:"no-database"};
  const day=new Date().toISOString().slice(0,10);
  const quota=await env.DB.prepare("SELECT used FROM mam_api_quota_guard WHERE day=?").bind(day).first();
  const decision=apiBackfillDecision(env,quota);
  if(!decision.allowed) return {skipped:decision.reason};
  // A bounded single candidate per cron tick. The durable retry table is checked by processApiCandidate.
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS mam_statistics_api_retry (source TEXT NOT NULL, fixture_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', next_attempt_ms INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source,fixture_id))").run();
  const row=await env.DB.prepare("SELECT m.source,m.fixture_id,m.kickoff,m.status,m.home_team_id,m.away_team_id,m.home_goals,m.away_goals,m.statistics_json,m.raw_json FROM matches m LEFT JOIN mam_statistics_api_retry r ON r.source=m.source AND r.fixture_id=m.fixture_id WHERE m.status IN ('FT','FINISHED','AET','PEN') AND (m.statistics_json IS NULL OR trim(m.statistics_json) IN ('','{}','[]','null')) AND (m.source IN ('api-football','API-Football','api_sports') OR (m.source='app' AND m.fixture_id NOT GLOB '*[^0-9]*' AND json_valid(m.raw_json)=1 AND CAST(json_extract(m.raw_json,'$.fixture.id') AS TEXT)=m.fixture_id AND CAST(json_extract(m.raw_json,'$.teams.home.id') AS TEXT)=CAST(m.home_team_id AS TEXT) AND CAST(json_extract(m.raw_json,'$.teams.away.id') AS TEXT)=CAST(m.away_team_id AS TEXT) AND json_extract(m.raw_json,'$.league.logo') LIKE 'https://media.api-sports.io/football/leagues/%')) AND (r.state IS NULL OR (r.state='waiting' AND r.next_attempt_ms<=?)) ORDER BY m.kickoff,m.fixture_id LIMIT 1").bind(Date.now()).first();
  if(!row) return {skipped:"no-eligible-candidate"};
  return processApiCandidate(env,row,request);
}
