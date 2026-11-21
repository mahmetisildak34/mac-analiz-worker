import {classifyApiCandidate,fetchVerifiedFixtureStatistics,retryDelayMs} from "./statistics-api-backfill.js";

// This processor is NOT connected to cron until provider quota and shared counter are audited.
// It writes only to an explicitly passed test/staging D1 database.
const empty="(statistics_json IS NULL OR trim(statistics_json) IN ('','{}','[]','null'))";
export async function ensureApiRetrySchema(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS mam_statistics_api_retry (source TEXT NOT NULL, fixture_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', next_attempt_ms INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source,fixture_id))").run();
}
export function validateApiStatistics(fixture,result) {
  if(classifyApiCandidate(fixture)!=="eligible-for-verified-provider-check"||result?.state!=="candidate") return false;
  const data=result.statistics;
  if(!Array.isArray(data)||data.length!==2||!data.every(x=>Array.isArray(x.statistics)&&x.statistics.length>0)) return false;
  const home=Number(fixture.home_team_id),away=Number(fixture.away_team_id);
  if(!Number.isSafeInteger(home)||home<=0||!Number.isSafeInteger(away)||away<=0||home===away) return false;
  if(Number(data[0].team?.id)!==home||Number(data[1].team?.id)!==away) return false;
  // Response's team identities must match the fixture; provider namespace and fixture ID
  // are validated before request, kickoff and score rechecked against current D1 row.
  return true;
}
export async function persistApiCandidate(db,fixture,result) {
  if(!validateApiStatistics(fixture,result)) return {state:"rejected"};
  const current=await db.prepare("SELECT source,fixture_id,kickoff,status,home_team_id,away_team_id,home_goals,away_goals,statistics_json,raw_json FROM matches WHERE source=? AND fixture_id=?").bind(fixture.source,fixture.fixture_id).first();
  if(!current||classifyApiCandidate(current)!=="eligible-for-verified-provider-check"||
     String(current.kickoff)!==String(fixture.kickoff)||
     Number(current.home_goals)!==Number(fixture.home_goals)||
     Number(current.away_goals)!==Number(fixture.away_goals)||
     Number(current.home_team_id)!==Number(fixture.home_team_id)||
     Number(current.away_team_id)!==Number(fixture.away_team_id)||
     !validateApiStatistics(current,result)) return {state:"stale-or-conflicting"};
  const data=JSON.stringify({teams:result.statistics.map((entry,i)=>({homeAway:i===0?"home":"away",team:entry.team.name||"",statistics:entry.statistics}))});
  const updated=await db.prepare("UPDATE matches SET statistics_json=?,updated_at=CURRENT_TIMESTAMP WHERE source=? AND fixture_id=? AND kickoff=? AND home_team_id=? AND away_team_id=? AND home_goals=? AND away_goals=? AND status IN ('FT','FINISHED','AET','PEN') AND "+empty).bind(data,fixture.source,fixture.fixture_id,fixture.kickoff,fixture.home_team_id,fixture.away_team_id,fixture.home_goals,fixture.away_goals).run();
  return {state:Number(updated.meta?.changes||0)===1?"saved":"not-written"};
}
export async function scheduleApiRetry(db,fixture,outcome,now=Date.now()) {
  await ensureApiRetrySchema(db);
  const prior=await db.prepare("SELECT attempts FROM mam_statistics_api_retry WHERE source=? AND fixture_id=?").bind(fixture.source,fixture.fixture_id).first();
  const attempts=Number(prior?.attempts||0)+1;
  const delay=outcome.state==="retry" ? (outcome.delayMs??retryDelayMs(outcome.status||0,attempts)) : null;
  const state=delay===null?"terminal":"waiting";
  await db.prepare("INSERT INTO mam_statistics_api_retry(source,fixture_id,attempts,state,next_attempt_ms,last_error) VALUES (?,?,?,?,?,?) ON CONFLICT(source,fixture_id) DO UPDATE SET attempts=excluded.attempts,state=excluded.state,next_attempt_ms=excluded.next_attempt_ms,last_error=excluded.last_error,updated_at=CURRENT_TIMESTAMP").bind(fixture.source,fixture.fixture_id,attempts,state,delay===null?0:now+delay,String(outcome.error||outcome.status||outcome.state).slice(0,500)).run();
  return {state,attempts,nextAttemptMs:delay===null?null:now+delay};
}
export async function processApiCandidate(env,fixture,request) {
  if(String(env.STATISTICS_API_BACKFILL_ENABLED)!=="true"||String(env.API_FOOTBALL_QUOTA_VERIFIED)!=="true") return {state:"disabled"};
  if(classifyApiCandidate(fixture)!=="eligible-for-verified-provider-check") return {state:"ineligible"};
  const db=env.DB;
  if(!db) return {state:"disabled"};
  await ensureApiRetrySchema(db);
  const pending=await db.prepare("SELECT state,next_attempt_ms FROM mam_statistics_api_retry WHERE source=? AND fixture_id=?").bind(fixture.source,fixture.fixture_id).first();
  if(pending?.state==="terminal"||(pending?.state==="waiting"&&pending.next_attempt_ms>Date.now())) return {state:"deferred"};
  const outcome=await fetchVerifiedFixtureStatistics(env,fixture,request);
  if(outcome.state==="candidate") {
    const saved=await persistApiCandidate(db,fixture,outcome);
    if(saved.state==="saved"||saved.state==="not-written") {
      await db.prepare("DELETE FROM mam_statistics_api_retry WHERE source=? AND fixture_id=?").bind(fixture.source,fixture.fixture_id).run();
      return saved;
    }
    return {...saved,retry:await scheduleApiRetry(db,fixture,{state:"terminal",error:saved.state})};
  }
  if(["retry","terminal","unusable"].includes(outcome.state))
    return {...outcome,retry:await scheduleApiRetry(db,fixture,outcome.state==="unusable"?{state:"retry",delayMs:3600000,error:"unusable-response"}:outcome)};
  return outcome;
}
