import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runStatisticsRepair, planStatisticsRepairTarget, rollbackStatisticsRepair, normalizeTeam, sameFixture } from "../statistics-repair.js";

function wrapper(database, { readOnly = false, beforeBatch = null } = {}) {
  return {
    prepare(sql) {
      if (readOnly && !/^\s*SELECT\b/i.test(sql)) throw new Error("Preview D1 attempted non-SELECT SQL: " + sql);
      let args = [];
      return {
        sql,
        bind(...values) { args = values; return this; },
        async first() { return database.prepare(sql).get(...args) || null; },
        async all() { return { results: database.prepare(sql).all(...args) }; },
        async run() { const result = database.prepare(sql).run(...args); return { meta: { changes: result.changes } }; },
        _args() { return args; }
      };
    },
    async batch(statements) {
      if (readOnly) throw new Error("Preview D1 batch is forbidden");
      if (beforeBatch) await beforeBatch(database, statements);
      database.exec("BEGIN");
      try {
        const results = statements.map(statement => {
          const result = database.prepare(statement.sql).run(...statement._args());
          return { meta: { changes: result.changes } };
        });
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    }
  };
}
function createProduction() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE matches(source TEXT NOT NULL,fixture_id TEXT NOT NULL,kickoff TEXT NOT NULL,status TEXT NOT NULL,home_team TEXT NOT NULL,away_team TEXT NOT NULL,home_team_id TEXT,away_team_id TEXT,home_goals INTEGER,away_goals INTEGER,statistics_json TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(source,fixture_id))");
  return db;
}
function createPreview() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE mam_history_backfill_matches(source TEXT NOT NULL,fixture_id TEXT NOT NULL,kickoff TEXT NOT NULL,home_team TEXT NOT NULL,away_team TEXT NOT NULL,home_team_id TEXT,away_team_id TEXT,home_goals INTEGER,away_goals INTEGER,statistics_json TEXT)");
  return db;
}
const stats = (home, away) => JSON.stringify({ teams: [
  { homeAway: "home", team: home, statistics: [{ name: "totalShots", displayValue: "12" }] },
  { homeAway: "away", team: away, statistics: [{ name: "totalShots", displayValue: "8" }] }
] });
const addProd = (db, i, { statsJson = null, status = "FT" } = {}) => db.prepare(
  "INSERT INTO matches VALUES ('app',?,?,?, ?,?,?,?,?,?,?,?)"
).run("p-" + String(i).padStart(4,"0"), "2025-01-01T12:00:00Z", status, "Home " + i, "Away " + i,
  "100", "200", 2, 1, statsJson, "2025-01-02T00:00:00Z");
const addPreview = (db, i, { statsJson = stats("Home " + i, "Away " + i), homeId = "100", awayId = "200", id = "preview-" + String(i).padStart(4,"0") } = {}) =>
  db.prepare("INSERT INTO mam_history_backfill_matches VALUES ('ESPN',?,?,?,?,?,?,?,?,?)")
    .run(id, "2025-01-01T12:00:00Z", "Home " + i, "Away " + i, homeId, awayId, 2, 1, statsJson);
const env = (DB, PREVIEW_DB, extra = {}) => ({
  DB, PREVIEW_DB, STATISTICS_REPAIR_ENABLED: "true",
  STATISTICS_REPAIR_APPLY_ENABLED: "true",
  STATISTICS_REPAIR_BACKUP_REQUIRED: "true",
  STATISTICS_REPAIR_CONFIRMATION: "APPLY_BULK_STATISTICS_REPAIR",
  STATISTICS_REPAIR_BATCH_SIZE: "25",
  ...extra
});

assert.equal(normalizeTeam("TÜRKIYE FC"), "turkiye");
assert.equal(sameFixture(
  { kickoff:"2025-01-01T00:00:00Z",home_team:"A",away_team:"B",home_team_id:"10",away_team_id:"20",home_goals:1,away_goals:0 },
  { kickoff:"2025-01-01T22:00:00+02:00",home_team:"A",away_team:"B",home_team_id:"10",away_team_id:"21",home_goals:1,away_goals:0 }
), false);

const production = createProduction(), preview = createPreview();
const p = wrapper(production), v = wrapper(preview,{readOnly:true});
for (let i=0;i<722;i++) addProd(production,i);
for (let i=0;i<44;i++) addPreview(preview,i);
// Existing populated statistics and unfinished rows must never be overwritten or selected.
addProd(production,9000,{statsJson:'{"already":"filled"}'});
addProd(production,9001,{status:"NS"});
// One duplicate Preview fixture with identical JSON is still ambiguous, not deduplicated by payload.
addPreview(preview,7,{id:"other-source-duplicate-0007"});

const dry = await runStatisticsRepair({DB:p,PREVIEW_DB:v,STATISTICS_REPAIR_ENABLED:"true"});
assert.equal(dry.dryRun,true);
assert.equal(dry.repaired,0);
assert.equal(production.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'mam_statistics_repair_%'").get().n,0);
assert.equal(production.prepare("SELECT statistics_json FROM matches WHERE fixture_id='p-0000'").get().statistics_json,null);

// Full 722-row candidate pool traversed in small, bounded batches.
let scanned=0,repaired=0,unmatched=0,ambiguous=0,runs=0;
for(let i=0;i<40 && scanned<722;i++){
  const result=await runStatisticsRepair(env(p,v));
  assert.ok(result.scanned<=25);
  scanned+=result.scanned; repaired+=result.repaired; unmatched+=result.unmatched; ambiguous+=result.ambiguous; runs++;
  if(result.scanned===0) break;
}
assert.equal(scanned,722);
assert.equal(repaired,43,"duplicate same-payload Preview record must be rejected");
assert.equal(ambiguous,1);
assert.equal(unmatched,678);
assert.equal(production.prepare("SELECT COUNT(*) n FROM mam_statistics_repair_backup WHERE state='applied'").get().n,43);
assert.equal(production.prepare("SELECT COUNT(*) n FROM mam_statistics_repair_queue").get().n,722);
assert.equal(production.prepare("SELECT COUNT(*) n FROM matches WHERE fixture_id='p-9000' AND statistics_json='{\"already\":\"filled\"}'").get().n,1);
assert.equal(production.prepare("SELECT statistics_json FROM matches WHERE fixture_id='p-9001'").get().statistics_json,null);
assert.equal(production.prepare("SELECT lease_until FROM mam_statistics_repair_control").get().lease_until,0);

// Idempotent repeat: no candidate gets overwritten or copied twice.
const again=await runStatisticsRepair(env(p,v));
assert.equal(again.repaired,0);
assert.equal(production.prepare("SELECT COUNT(*) n FROM mam_statistics_repair_backup WHERE state='applied'").get().n,43);

// Rollback is SHA-guarded and restores the exact pre-update NULL value.
const backup=production.prepare("SELECT source,fixture_id,candidate_sha256 FROM mam_statistics_repair_backup WHERE state='applied' LIMIT 1").get();
const rolled=await rollbackStatisticsRepair(p,backup.source,backup.fixture_id,backup.candidate_sha256);
assert.equal(rolled.rolledBack,true);
assert.equal(production.prepare("SELECT statistics_json FROM matches WHERE source=? AND fixture_id=?").get(backup.source,backup.fixture_id).statistics_json,null);
assert.equal((await rollbackStatisticsRepair(p,backup.source,backup.fixture_id,backup.candidate_sha256)).rolledBack,false);

// Tampered backup payload is rejected by SHA-256 before rollback.
const corrupt=production.prepare("SELECT source,fixture_id,candidate_sha256 FROM mam_statistics_repair_backup WHERE state='applied' LIMIT 1").get();
production.prepare("UPDATE mam_statistics_repair_backup SET candidate_statistics_json='tampered' WHERE source=? AND fixture_id=? AND candidate_sha256=?").run(corrupt.source,corrupt.fixture_id,corrupt.candidate_sha256);
await assert.rejects(()=>rollbackStatisticsRepair(p,corrupt.source,corrupt.fixture_id,corrupt.candidate_sha256),/backup-candidate-sha256-mismatch/);

// Missing explicit apply gates always remain read-only dry-run.
const gated=await runStatisticsRepair({DB:p,PREVIEW_DB:v,STATISTICS_REPAIR_ENABLED:"true",STATISTICS_REPAIR_APPLY_ENABLED:"true"});
assert.equal(gated.dryRun,true);

// Fail-stop: a transaction error does not partially apply the row or advance the cursor.
const failingProd=createProduction(), failingPreview=createPreview();
addProd(failingProd,0); addPreview(failingPreview,0);
const failingWrap=wrapper(failingProd,{beforeBatch:async(db,statements)=>{
  if(statements.some(s=>s.sql.startsWith("UPDATE matches SET statistics_json"))) throw new Error("injected write failure");
}});
const failEnv=env(failingWrap,wrapper(failingPreview,{readOnly:true}));
await assert.rejects(()=>runStatisticsRepair(failEnv),/injected write failure/);
assert.equal(failingProd.prepare("SELECT statistics_json FROM matches WHERE fixture_id='p-0000'").get().statistics_json,null);
assert.equal(failingProd.prepare("SELECT cursor_fixture_id FROM mam_statistics_repair_control").get().cursor_fixture_id,"");
assert.equal(failingProd.prepare("SELECT lease_until FROM mam_statistics_repair_control").get().lease_until,0);

// A stale Production snapshot must fail closed before any statistics are copied.
const staleProd=createProduction(), stalePreview=createPreview();
addProd(staleProd,2); addPreview(stalePreview,2);
let staleInjected=false;
const staleWrap=wrapper(staleProd,{beforeBatch:async(db,statements)=>{
  if(!staleInjected && statements.some(s=>s.sql.startsWith("UPDATE matches SET statistics_json"))){
    db.prepare("UPDATE matches SET updated_at='2025-01-03T00:00:00Z' WHERE fixture_id='p-0002'").run();
    staleInjected=true;
  }
}});
await assert.rejects(()=>runStatisticsRepair(env(staleWrap,wrapper(stalePreview,{readOnly:true}))),/conditional-update-did-not-change-exactly-one-row/);
assert.equal(staleProd.prepare("SELECT statistics_json FROM matches WHERE fixture_id='p-0002'").get().statistics_json,null);
assert.equal(staleProd.prepare("SELECT COUNT(*) n FROM mam_statistics_repair_backup").get().n,0);
assert.equal(staleProd.prepare("SELECT cursor_fixture_id FROM mam_statistics_repair_control").get().cursor_fixture_id,"");

// Preview ambiguity, invalid JSON, and team-ID conflict are all rejected.
const singleProd=createProduction(), singlePrev=createPreview();
addProd(singleProd,1); addPreview(singlePrev,1);
addPreview(singlePrev,1,{id:"preview-duplicate-0001"});
let plan=await planStatisticsRepairTarget(wrapper(singlePrev,{readOnly:true}),singleProd.prepare("SELECT * FROM matches WHERE fixture_id='p-0001'").get());
assert.equal(plan.state,"ambiguous");
const invalidPrev=createPreview(); addPreview(invalidPrev,1,{statsJson:"{\"teams\":["});
plan=await planStatisticsRepairTarget(wrapper(invalidPrev,{readOnly:true}),singleProd.prepare("SELECT * FROM matches WHERE fixture_id='p-0001'").get());
assert.equal(plan.state,"rejected");
const conflictPrev=createPreview(); addPreview(conflictPrev,1,{homeId:"999"});
plan=await planStatisticsRepairTarget(wrapper(conflictPrev,{readOnly:true}),singleProd.prepare("SELECT * FROM matches WHERE fixture_id='p-0001'").get());
assert.equal(plan.state,"rejected");

console.log(JSON.stringify({ok:true,productionCandidatePool:722,previewMatchedFixtureRows:44,applied:43,ambiguous:1,unmatched:678,batchLimit:25,batches:runs,backupRows:43,rollback:true,shaTamperRejected:true,staleSnapshotRejected:true,idempotence:true,failStop:true,previewReadOnly:true}));
