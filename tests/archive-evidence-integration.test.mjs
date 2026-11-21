import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import worker from "../worker.js";
import { predictTrustedGoals } from "../trusted-goal-poisson.js";

const raw = JSON.parse(readFileSync(new URL("./fixtures/espn-leeds-tottenham-401878758.json", import.meta.url)));
const row = {
  source:"ESPN", fixture_id:"espn-eng.1-401878758", league_id:"39",
  league_name:"Premier League", country:"England", kickoff:raw.date, status:"FT",
  home_team_id:"357", home_team:"Leeds United", away_team_id:"367", away_team:"Tottenham Hotspur",
  home_goals:1, away_goals:0, statistics_json:null, raw_json:JSON.stringify(raw)
};
const request = new Request("https://archive.test/api/archive/matches?league=39&before=2026-11-08&limit=4");
const database = rows => ({
  prepare(sql) {
    assert.match(sql.trim(), /^SELECT\s/);
    return {bind(...params) {
      assert.deepEqual(params, ["39","2026-11-08",4]);
      return {all:async()=>({results:rows})};
    }};
  }
});
const response = await worker.fetch(request,{DB:database([row])});
assert.equal(response.status,200);
const example = await response.json();
const [fixture] = example.response;
assert.equal(fixture.source,"ESPN");
assert.equal(fixture.mamSource,"ESPN");
assert.equal(fixture.identity_verified,true);
assert.equal(fixture.score_verified,true);
assert.equal(fixture.halftime_score_verified,false);
assert.equal(fixture.verification_evidence,"archived_espn_provider_payload");
assert.equal(fixture.statistics,null);
assert.equal(fixture.data_quality.status,"missing");
const badRows = [{...row,home_goals:2},{...row,kickoff:"2026-11-07T12:00:00Z"},
  {...row,raw_json:JSON.stringify({fixture:{id:row.fixture_id},goals:{home:1,away:0}})}];
const bad = await (await worker.fetch(request,{DB:database(badRows)})).json();
assert.deepEqual(bad.response.map(r=>[r.identity_verified,r.score_verified]),[[true,false],[false,false],[false,false]]);
const appRow={...row,source:"app",fixture_id:"8961"};
const appFixture={fixture:{id:8961,date:row.kickoff,timestamp:Date.parse(row.kickoff)/1000,status:{short:"FT"}},
  teams:{home:{name:row.home_team},away:{name:row.away_team}}, goals:{home:1,away:0}};
const halfRows=[{home:0,away:0},{home:2,away:0},{home:null,away:0}].map(halftime=>
  ({...appRow,raw_json:JSON.stringify({...appFixture,score:{halftime}})}));
const halftime=await (await worker.fetch(request,{DB:database(halfRows)})).json();
assert.deepEqual(halftime.response.map(r=>r.halftime_score_verified),[true,false,false]);
const toPoisson = r => ({
  source:r.source, fixture_id:r.fixture.id, kickoff:r.fixture.date, status:r.fixture.status.short,
  home_team:r.teams.home.name, away_team:r.teams.away.name, home_goals:r.goals.home,
  away_goals:r.goals.away, identity_verified:r.identity_verified, score_verified:r.score_verified
});
const prediction = predictTrustedGoals([fixture,...bad.response].map(toPoisson),{
  home_team:"Leeds United", away_team:"Arsenal", as_of:"2026-11-08",
  league_average_home_goals:1.5, league_average_away_goals:1.2
});
assert.equal(prediction.available,false);
assert.equal(prediction.reason,"insufficient_verified_venue_sample");
assert.equal(prediction.reasons.score_not_verified,1);
assert.equal(prediction.reasons.identity_not_verified,2);
assert.equal(prediction.probabilities,undefined);
if (process.argv[2]) writeFileSync(process.argv[2],JSON.stringify(example,null,2)+"\n");
