import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import { parseFixtureDownloadUtc, fixtureDownloadFeed, resolveFixtureDownloadImport } from "../uefa-fixture-import.js";
import worker from "../worker.js";

const match={MatchNumber:14,RoundNumber:1,DateUtc:"2024-09-19 16:45:00Z",HomeTeam:"Feyenoord",AwayTeam:"Leverkusen",HomeTeamScore:0,AwayTeamScore:4};
const spec=fixtureDownloadFeed("fd-uefa-champions-league-2024-14","2");
const input={kickoff:"2024-09-19T12:00:00Z",homeName:"Feyenoord",awayName:"Leverkusen",homeGoals:0,awayGoals:4,status:"FT"};
const fixed=resolveFixtureDownloadImport(input,spec,[match]);
assert.equal(fixed.kickoff,"2024-09-19T16:45:00.000Z");
assert.deepEqual(fixed.evidence.original,match);
assert.equal(fixed.evidence.source_url,"https://fixturedownload.com/feed/json/champions-league-2024");
assert.equal(fixtureDownloadFeed("fd-uefa-champions-league-2024-14","3"),null);
assert.equal(resolveFixtureDownloadImport(input,spec,[match,match]),null);
assert.equal(resolveFixtureDownloadImport({...input,homeGoals:null},spec,[match]),null);
assert.equal(resolveFixtureDownloadImport({...input,homeName:"Leverkusen"},spec,[match]),null);
assert.equal(resolveFixtureDownloadImport({...input,kickoff:"2024-09-19T01:00:00Z"},spec,[match]),null);
assert.equal(resolveFixtureDownloadImport(input,spec,[{...match,DateUtc:"2024-09-19 23:45:00Z"}]).kickoff,"2024-09-19T23:45:00.000Z");
assert.equal(new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Istanbul",day:"2-digit"}).format(new Date("2024-09-19T23:45:00Z")),"20");
for(const invalid of ["2024-02-30 16:45:00Z","2024-09-19 24:00:00Z","2024-09-19 16:45:00","2024-09-19T19:45:00+03:00",null]){
  assert.equal(parseFixtureDownloadUtc(invalid),null);
}

const db=new DatabaseSync(":memory:");
db.exec(`CREATE TABLE matches(
  source TEXT, fixture_id TEXT, league_id TEXT, league_name TEXT, country TEXT, kickoff TEXT, status TEXT,
  home_team_id TEXT, home_team TEXT, away_team_id TEXT, away_team TEXT, home_goals INT, away_goals INT,
  statistics_json TEXT, raw_json TEXT, updated_at TEXT, PRIMARY KEY(source,fixture_id));`);
const env={SITE_PASSWORD:"local-test",SESSION_SECRET:"temporary-test-secret",
  DB:{prepare:sql=>({bind:(...args)=>({sql,args})}),
    batch:async statements=>statements.map(({sql,args})=>({meta:{changes:Number(db.prepare(sql).run(...args).changes)}}))}};
const signIn=await worker.fetch(new Request("https://local.test/auth/login",{method:"POST",
  body:JSON.stringify({password:env.SITE_PASSWORD})}),env);
const {token}=await signIn.json();
const id="fd-uefa-champions-league-2024-14";
db.prepare(`INSERT INTO matches(source,fixture_id,league_id,kickoff,home_team,away_team,home_goals,away_goals,statistics_json)
  VALUES ('fixture-download-uefa',?,'2','2024-09-19T12:00:00Z','Feyenoord','Leverkusen',0,4,'{"preserved":true}')`).run(id);
const request=()=>new Request("https://local.test/api/archive/matches",{method:"POST",
  headers:{Authorization:"Bearer "+token},body:JSON.stringify({matches:[{
    mamSource:"fixture-download-uefa", fixture:{id,date:input.kickoff,status:{short:"FT"}},
    league:{id:"2"}, teams:{home:{name:input.homeName},away:{name:input.awayName}},
    goals:{home:0,away:4}, statistics:{unverified:true},provider_evidence:{original:"caller data"}
  }]})});
const originalFetch=globalThis.fetch;
try {
  globalThis.fetch=async url=>{
    assert.equal(url,"https://fixturedownload.com/feed/json/champions-league-2024");
    return Response.json([match]);
  };
  assert.equal((await (await worker.fetch(request(),env)).json()).saved,1);
  const stored=db.prepare("SELECT kickoff,statistics_json,raw_json FROM matches").get();
  assert.equal(stored.kickoff,fixed.kickoff);
  assert.deepEqual(JSON.parse(stored.statistics_json),{preserved:true});
  assert.deepEqual(JSON.parse(stored.raw_json).provider_evidence.original,match);
  assert.equal((await (await worker.fetch(request(),env)).json()).saved,0);
  db.exec("UPDATE matches SET kickoff='2024-09-19T17:00:00Z'");
  assert.equal((await (await worker.fetch(request(),env)).json()).saved,0);
  assert.equal(db.prepare("SELECT kickoff FROM matches").get().kickoff,"2024-09-19T17:00:00Z");
  globalThis.fetch=async()=>new Response(null,{status:503});
  assert.equal((await (await worker.fetch(request(),env)).json()).skipped,1);
} finally {
  globalThis.fetch=originalFetch;
  db.close();
}
