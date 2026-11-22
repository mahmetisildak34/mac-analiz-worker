// Provider transport for isolated-only verification. Not connected to production or cron.
// This function makes two API-Sports requests ONLY when explicitly enabled by caller.
// Never use fixture/verification flags supplied by an untrusted caller as source proof.
import { persistIsolatedVerifiedStatistics } from './isolated-verified-statistics-repair.js';
import { reserveApiBackfillCall } from './statistics-api-backfill.js';
const origin='https://v3.football.api-sports.io';
export async function fetchAndRepairIsolatedApiSports(env, fixture, request=fetch) {
  if(env?.ISOLATED_STATISTICS_REPAIR_ENABLED!=='true' || env?.ISOLATED_PROVIDER_FETCH_ENABLED!=='true' ||
    !env?.TEST_WRITE_DB || env.DB || env.PRODUCTION_READ_DB || env.PREVIEW_READ_DB ||
    !env.API_FOOTBALL_KEY || env.API_FOOTBALL_QUOTA_VERIFIED!=='true' ||
    !env.API_FOOTBALL_DAILY_LIMIT || !env.API_FOOTBALL_VERIFIED_LIMIT) return {state:'disabled'};
  if(!/^[1-9]\d{0,11}$/.test(String(fixture?.fixture_id??''))) return {state:'rejected',reason:'invalid_provider_fixture_id'};
  const headers={'x-apisports-key':env.API_FOOTBALL_KEY};
  const paths=['/fixtures?id=','/fixtures/statistics?fixture='];
  const payloads=[];
  for(const path of paths) {
    // Reserve EACH call atomically in the shared counter. Never trust a caller flag.
    let reserved;
    try { reserved=await reserveApiBackfillCall(env.TEST_WRITE_DB,{...env,STATISTICS_API_BACKFILL_ENABLED:'true'}); }
    catch { return {state:'quota_unavailable'}; }
    if(!reserved?.allowed) return {state:'quota_blocked',reason:reserved?.reason||'reservation_denied'};
    let response;
    try {
      response=await request(origin+path+encodeURIComponent(fixture.fixture_id),{headers,redirect:'error',signal:AbortSignal.timeout(12000)});
    } catch {return {state:'provider_unavailable'};}
    if(!response?.ok || response.url && !response.url.startsWith(origin+'/')) return {state:'provider_unavailable'};
    const json=await response.json().catch(()=>null);
    if(!json || !Array.isArray(json.response) || json.errors && (Array.isArray(json.errors)?json.errors.length:Object.keys(json.errors).length)) return {state:'provider_unusable'};
    payloads.push(json);
  }
  return persistIsolatedVerifiedStatistics(env,fixture,payloads[0],payloads[1]);
}
