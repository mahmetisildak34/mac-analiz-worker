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
  const row=await env.DB.prepare("SELECT source,fixture_id,kickoff,status,home_team_id,away_team_id,home_goals,away_goals,statistics_json FROM matches WHERE source IN ('api-football','API-Football','api_sports') AND status IN ('FT','FINISHED','AET','PEN') AND (statistics_json IS NULL OR length(trim(statistics_json))<=5) ORDER BY kickoff,fixture_id LIMIT 1").first();
  if(!row) return {skipped:"no-eligible-candidate"};
  return processApiCandidate(env,row,request);
}
