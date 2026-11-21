// API-Football statistics backfill: fail-closed, never invoked unless explicitly enabled.
// app rows are accepted only when raw_json proves the exact API-Sports fixture/team identity.
const finished=new Set(["FT","FINISHED","AET","PEN"]);
const directSources=new Set(["api-football","API-Football","api_sports"]);
export function hasApiFootballIdentity(match) {
  if (!match || !/^[1-9]\d{0,11}$/.test(String(match.fixture_id||""))) return false;
  if (directSources.has(String(match.source||""))) return true;
  if (String(match.source||"") !== "app") return false;
  let raw;
  try { raw = typeof match.raw_json === "string" ? JSON.parse(match.raw_json) : match.raw_json; }
  catch { return false; }
  const fixtureId = String(raw?.fixture?.id ?? "");
  const homeId = String(raw?.teams?.home?.id ?? "");
  const awayId = String(raw?.teams?.away?.id ?? "");
  const leagueLogo = String(raw?.league?.logo ?? "");
  return fixtureId === String(match.fixture_id) &&
    /^[1-9]\d*$/.test(homeId) && /^[1-9]\d*$/.test(awayId) && homeId !== awayId &&
    String(match.home_team_id ?? "") === homeId &&
    String(match.away_team_id ?? "") === awayId &&
    leagueLogo.startsWith("https://media.api-sports.io/football/leagues/") &&
    /[0-9]+\.png(?:\?|$)/i.test(leagueLogo);
}
export function classifyApiCandidate(match) {
  if(!match||!finished.has(String(match.status||"").toUpperCase())) return "not-finished";
  const stats = String(match.statistics_json ?? "").trim();
  if(stats.length>5 && !["{}","[]","null"].includes(stats)) return "already-populated";
  if(!hasApiFootballIdentity(match)) return "unverified-provider-source";
  return "eligible-for-verified-provider-check";
}
export function apiBackfillDecision(env,quota) {
  if(String(env?.STATISTICS_API_BACKFILL_ENABLED||"")!=="true") return {allowed:false,reason:"feature-disabled"};
  if(String(env?.API_FOOTBALL_QUOTA_VERIFIED||"")!=="true") return {allowed:false,reason:"provider-quota-unverified"};
  const configured=Number(env?.API_FOOTBALL_DAILY_LIMIT),verified=Number(env?.API_FOOTBALL_VERIFIED_LIMIT),used=Number(quota?.used);
  if(!Number.isSafeInteger(configured)||configured<=0||!Number.isSafeInteger(verified)||verified<=0||configured>verified)
    return {allowed:false,reason:"invalid-verified-budget"};
  if(!Number.isSafeInteger(used)||used<0) return {allowed:false,reason:"missing-shared-quota-state"};
  const reserve=Math.max(10,Math.ceil(verified*0.2));
  if(configured-used-reserve<=0) return {allowed:false,reason:"budget-exhausted"};
  return {allowed:true,remainingBatch:Math.min(5,configured-used-reserve),reason:"eligible-only-after-shared-atomic-reservation"};
}
export async function reserveApiBackfillCall(db,env,now=Date.now()) {
  const day=new Date(now).toISOString().slice(0,10);
  const row=await db.prepare("SELECT used FROM mam_api_quota_guard WHERE day=?").bind(day).first();
  const decision=apiBackfillDecision(env,row);
  if(!decision.allowed) return decision;
  const configured=Number(env.API_FOOTBALL_DAILY_LIMIT),verified=Number(env.API_FOOTBALL_VERIFIED_LIMIT);
  const safeLimit=configured-Math.max(10,Math.ceil(verified*0.2));
  // Same atomic shared counter used by the public API proxy; 8s slot protects rate limits.
  const result=await db.prepare("UPDATE mam_api_quota_guard SET used=used+1,minute_last_ms=? WHERE day=? AND used<? AND minute_last_ms<=? RETURNING used").bind(now+8000,day,safeLimit,now).first();
  return result?{allowed:true,used:result.used,day}:{allowed:false,reason:"shared-reservation-denied"};
}
export function retryDelayMs(status,attempt,retryAfterSeconds=0) {
  if(status===401||status===403) return null;
  if(status===429) return Math.max(60000,Math.min(86400000,Number(retryAfterSeconds||0)*1000||3600000));
  if(status>=500||status===0) return Math.min(86400000,60000*2**Math.min(10,attempt));
  return null;
}
export async function fetchVerifiedFixtureStatistics(env,fixture,request=fetch) {
  if(classifyApiCandidate(fixture)!=="eligible-for-verified-provider-check") return {state:"ineligible"};
  if(String(env.STATISTICS_API_BACKFILL_ENABLED)!=="true"||String(env.API_FOOTBALL_QUOTA_VERIFIED)!=="true")
    return {state:"disabled"};
  if(!env.DB||!env.API_FOOTBALL_KEY) return {state:"disabled"};
  const reserved=await reserveApiBackfillCall(env.DB,env);
  if(!reserved.allowed) return {state:"blocked",reason:reserved.reason};
  let response;
  try {
    response=await request("https://v3.football.api-sports.io/fixtures/statistics?fixture="+encodeURIComponent(fixture.fixture_id),{
      headers:{"x-apisports-key":env.API_FOOTBALL_KEY},signal:AbortSignal.timeout(12000)
    });
  }catch(error){return {state:"retry",delayMs:retryDelayMs(0,1),error:String(error?.message||error)};}
  if(!response.ok) return {state:retryDelayMs(response.status,1,response.headers.get("Retry-After"))===null?"terminal":"retry",status:response.status,delayMs:retryDelayMs(response.status,1,response.headers.get("Retry-After"))};
  const body=await response.json().catch(()=>null);
  if(!body||!Array.isArray(body.response)||body.response.length!==2||!body.response.every(x=>x.team?.id&&Array.isArray(x.statistics)))
    return {state:"unusable"};
  // This module returns verified candidate data; caller must additionally verify home/away team IDs
  // against the fixture before performing a conditional, empty-only D1 UPDATE.
  return {state:"candidate",statistics:body.response,quotaReserved:true};
}
