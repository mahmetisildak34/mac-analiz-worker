// Isolated-only, fail-closed repair from two independently supplied API-Sports responses.
// No network requests. Caller must provide raw fixture and statistics provider responses.
// Never accept caller-provided provider_verified or identity_verified flags as evidence.
import { verifyStatisticsCandidate } from './verified-statistics-candidate.js';

const id = x => /^[1-9]\d*$/.test(String(x ?? ''));
const normalizedTime = x => { const t = Date.parse(x); return Number.isFinite(t) ? t : NaN; };
export function deriveVerifiedApiSportsEvidence(fixture, fixtureResponse, statisticsResponse) {
  const reject = reason => ({state:'rejected',reason});
  if (!fixture || !['api-football','API-Football','api_sports','app'].includes(fixture.source) || !id(fixture.fixture_id)) return reject('unsupported_fixture_source');
  if (!fixtureResponse || !statisticsResponse || !Array.isArray(fixtureResponse.response) || fixtureResponse.response.length !== 1 || !Array.isArray(statisticsResponse.response) || statisticsResponse.response.length !== 2) return reject('provider_payload_required');
  const event = fixtureResponse.response[0];
  if (String(event?.fixture?.id) !== String(fixture.fixture_id) || !['FT','AET','PEN'].includes(event?.fixture?.status?.short)) return reject('provider_fixture_not_final');
  if (normalizedTime(event?.fixture?.date) !== normalizedTime(fixture.kickoff)) return reject('provider_kickoff_mismatch');
  if (String(event?.teams?.home?.id) !== String(fixture.home_team_id) || String(event?.teams?.away?.id) !== String(fixture.away_team_id)) return reject('provider_team_id_mismatch');
  if (event?.goals?.home !== fixture.home_goals || event?.goals?.away !== fixture.away_goals) return reject('provider_score_mismatch');
  if (event?.teams?.home?.name !== fixture.home_team || event?.teams?.away?.name !== fixture.away_team) return reject('provider_team_name_mismatch');
  const home = statisticsResponse.response.find(x => String(x?.team?.id) === String(fixture.home_team_id));
  const away = statisticsResponse.response.find(x => String(x?.team?.id) === String(fixture.away_team_id));
  if (!home || !away || home === away) return reject('provider_statistics_team_mismatch');
  const evidence = {source:fixture.source,fixture_id:fixture.fixture_id,provider:'API-Sports',provider_verified:true,identity_verified:true,kickoff:fixture.kickoff,home_goals:fixture.home_goals,away_goals:fixture.away_goals,teams:[{...home,homeAway:'home'},{...away,homeAway:'away'}]};
  return verifyStatisticsCandidate(fixture,evidence);
}
export async function persistIsolatedVerifiedStatistics(env,fixture,fixtureResponse,statisticsResponse) {
  if (env?.ISOLATED_STATISTICS_REPAIR_ENABLED !== 'true' || !env?.TEST_WRITE_DB || env.DB || env.PRODUCTION_READ_DB || env.PREVIEW_READ_DB) return {state:'disabled'};
  const result = deriveVerifiedApiSportsEvidence(fixture,fixtureResponse,statisticsResponse);
  if (result.state !== 'verified') return result;
  const db = env.TEST_WRITE_DB;
  const current = await db.prepare('SELECT source,fixture_id,kickoff,status,home_team_id,away_team_id,home_team,away_team,home_goals,away_goals,statistics_json FROM matches WHERE source=? AND fixture_id=?').bind(fixture.source,fixture.fixture_id).first();
  if (!current || Object.keys(fixture).some(k => ['source','fixture_id','kickoff','status','home_team_id','away_team_id','home_team','away_team','home_goals','away_goals'].includes(k) && String(current[k]) !== String(fixture[k]))) return {state:'stale_or_conflicting'};
  const again = deriveVerifiedApiSportsEvidence(current,fixtureResponse,statisticsResponse);
  if (again.state !== 'verified') return {state:'stale_or_conflicting'};
  if (current.statistics_json != null && !['','{}','[]','null'].includes(String(current.statistics_json).trim())) return {state:'already_populated'};
  const write = await db.prepare("UPDATE matches SET statistics_json=? WHERE source=? AND fixture_id=? AND kickoff=? AND status IN ('FT','AET','PEN') AND home_team_id=? AND away_team_id=? AND home_goals=? AND away_goals=? AND (statistics_json IS NULL OR trim(statistics_json) IN ('','{}','[]','null'))").bind(again.statistics_json,current.source,current.fixture_id,current.kickoff,current.home_team_id,current.away_team_id,current.home_goals,current.away_goals).run();
  return {state:Number(write.meta?.changes) === 1 ? 'saved' : 'not_written'};
}
