import assert from "node:assert/strict";
import {apiBackfillDecision,classifyApiCandidate,hasApiFootballIdentity,retryDelayMs,fetchVerifiedFixtureStatistics} from "../statistics-api-backfill.js";
assert.equal(apiBackfillDecision({},{}).allowed,false);
assert.equal(apiBackfillDecision({STATISTICS_API_BACKFILL_ENABLED:"true"},{used:0}).reason,"provider-quota-unverified");
assert.equal(apiBackfillDecision({STATISTICS_API_BACKFILL_ENABLED:"true",API_FOOTBALL_QUOTA_VERIFIED:"true",API_FOOTBALL_DAILY_LIMIT:"85",API_FOOTBALL_VERIFIED_LIMIT:"100"},{used:80}).allowed,false);
assert.equal(apiBackfillDecision({STATISTICS_API_BACKFILL_ENABLED:"true",API_FOOTBALL_QUOTA_VERIFIED:"true",API_FOOTBALL_DAILY_LIMIT:"85",API_FOOTBALL_VERIFIED_LIMIT:"100"},{used:0}).remainingBatch,5);
assert.equal(classifyApiCandidate({status:"NS",fixture_id:"123"}),"not-finished");
assert.equal(classifyApiCandidate({status:"FT",source:"api-football",fixture_id:"espn-123"}),"no-provider-fixture-id");
assert.equal(classifyApiCandidate({status:"FT",source:"api-football",fixture_id:"123",statistics_json:'{"shots":3}'}),"already-populated");
assert.equal(classifyApiCandidate({status:"FT",source:"api-football",fixture_id:"123",statistics_json:null}),"eligible-for-verified-provider-check");
console.log("API backfill remains gated on verified provider quota, shared quota and provider IDs");

assert.equal(classifyApiCandidate({status:"FT",source:"ESPN",fixture_id:"123",statistics_json:null}),"unverified-provider-source");
assert.equal(retryDelayMs(401,1),null);
assert.equal(retryDelayMs(429,1,120),120000);
let called=false;
const noNetwork=async()=>{called=true;throw Error("network must not be called");};
assert.equal((await fetchVerifiedFixtureStatistics({STATISTICS_API_BACKFILL_ENABLED:"false"},{status:"FT",source:"api-football",fixture_id:"123"},noNetwork)).state,"disabled");
assert.equal(called,false);

const apiAppFixture = {
  source:"app",fixture_id:"123456",status:"FT",home_team_id:"10",away_team_id:"20",statistics_json:null,
  raw_json:JSON.stringify({
    fixture:{id:123456},
    league:{logo:"https://media.api-sports.io/football/leagues/39.png"},
    teams:{home:{id:10},away:{id:20}}
  })
};
assert.equal(hasApiFootballIdentity(apiAppFixture),true);
assert.equal(classifyApiCandidate(apiAppFixture),"eligible-for-verified-provider-check");
assert.equal(classifyApiCandidate({...apiAppFixture,fixture_id:"123457"}),"unverified-provider-source");
assert.equal(classifyApiCandidate({...apiAppFixture,home_team_id:"99"}),"unverified-provider-source");
assert.equal(classifyApiCandidate({...apiAppFixture,raw_json:"{}"}),"unverified-provider-source");
assert.equal(classifyApiCandidate({...apiAppFixture,statistics_json:'{"teams":[{"statistics":[{"name":"shots"}]}]}' }),"already-populated");
assert.equal(classifyApiCandidate({...apiAppFixture,source:"sportscore"}),"unverified-provider-source");
