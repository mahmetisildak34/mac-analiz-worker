import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { planStatisticsRepairTarget } from "../statistics-repair.js";
const db=new DatabaseSync(":memory:");
db.exec("CREATE TABLE mam_history_backfill_matches(source TEXT,fixture_id TEXT,kickoff TEXT,home_team TEXT,away_team TEXT,home_team_id TEXT,away_team_id TEXT,home_goals INTEGER,away_goals INTEGER,statistics_json TEXT)");
const stats=JSON.stringify({teams:[{team:"Portugal",statistics:[{name:"shots",displayValue:"12"}]},{team:"Croatia",statistics:[{name:"shots",displayValue:"8"}]}]});
db.prepare("INSERT INTO mam_history_backfill_matches VALUES ('ESPN','espn-698888','2024-09-05T18:45Z','Portugal','Croatia','482','477',2,1,?)").run(stats);
const preview={prepare(sql){assert.match(sql,/^\s*SELECT\b/i,"Preview must be SELECT-only");let args=[];return{bind(...a){args=a;return this},async all(){return{results:db.prepare(sql).all(...args)}}}}};
const target={kickoff:"2024-09-05T18:45Z",home_team:"Portugal",away_team:"Croatia",home_team_id:"482",away_team_id:"-1",home_goals:2,away_goals:1,fixture_id:"698888"};
const plan=await planStatisticsRepairTarget(preview,target);
assert.equal(plan.state,"ready");assert.equal(plan.statistics_sha256.length,64);assert.equal(plan.teams,2);
console.log("preview integration: exact date/team/score, compatible IDs, fixture suffix and SHA-256 passed");

db.exec("ALTER TABLE mam_history_backfill_matches ADD COLUMN league_id TEXT");
db.exec("ALTER TABLE mam_history_backfill_matches ADD COLUMN league_name TEXT");
db.exec("ALTER TABLE mam_history_backfill_matches ADD COLUMN country TEXT");
const aliasStats=JSON.stringify({teams:[
  {team:"Man Utd",statistics:[{name:"shots",displayValue:"8"}]},
  {team:"Man City",statistics:[{name:"shots",displayValue:"5"}]}
]});
db.prepare("INSERT INTO mam_history_backfill_matches(source,fixture_id,kickoff,home_team,away_team,home_team_id,away_team_id,home_goals,away_goals,statistics_json,league_id,league_name,country) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("ESPN","espn-eng.1-999999","2025-10-02T15:00:00Z","Manchester United","Manchester City","100","200",1,0,aliasStats,"99","English Premier League","England");
const aliasTarget={source:"app",fixture_id:"998877",kickoff:"2025-10-02T15:00:00Z",home_team:"Man Utd",away_team:"Man City",home_team_id:"100",away_team_id:"200",home_goals:1,away_goals:0,league_id:"39",league_name:"Premier League",country:"England"};
const aliasPlan=await planStatisticsRepairTarget(preview,aliasTarget);
assert.equal(aliasPlan.state,"ready","cross-provider fixture suffixes must not be compared across namespaces");
assert.equal(aliasPlan.fixture_id,"espn-eng.1-999999");
assert.equal(aliasPlan.statistics_sha256.length,64);
