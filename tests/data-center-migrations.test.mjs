import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = path.join(root, "migrations");
const files = fs.readdirSync(migrationDirectory).filter(file => /^\d+_.*\.sql$/.test(file)).sort();
const expectedFiles = [
  "0001_team_identity.sql",
  "0002_daily_history.sql",
  "0003_match_data_center.sql",
  "0004_b_fixture_staging.sql"
];

function applyAll(db) {
  for (const file of files) db.exec(fs.readFileSync(path.join(migrationDirectory, file), "utf8"));
}
function schemaSnapshot(db) {
  return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
}
function legacySnapshot(db) {
  return {
    sql: db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='matches'").get().sql,
    columns: JSON.stringify(db.prepare("PRAGMA table_info(matches)").all()),
    count: db.prepare("SELECT COUNT(*) AS n FROM matches").get().n,
    sentinel: JSON.stringify(db.prepare("SELECT * FROM matches WHERE source='legacy' AND fixture_id='sentinel'").get())
  };
}

test("ordered Worker migrations are additive, contain no archive backfill, and rerun idempotently", () => {
  assert.deepEqual(files, expectedFiles, "migration order is explicit and reviewed");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`CREATE TABLE matches (
      source TEXT NOT NULL, fixture_id TEXT NOT NULL, league_id TEXT NOT NULL, league_name TEXT,
      country TEXT, kickoff TEXT NOT NULL, status TEXT NOT NULL, home_team_id TEXT, home_team TEXT,
      away_team_id TEXT, away_team TEXT, home_goals INTEGER, away_goals INTEGER,
      statistics_json TEXT, raw_json TEXT, updated_at TEXT, PRIMARY KEY(source,fixture_id)
    );`);
    db.prepare(`INSERT INTO matches(source,fixture_id,league_id,kickoff,status,home_team,away_team,updated_at)
      VALUES('legacy','sentinel','test','2020-01-01T12:00:00Z','FT','Home','Away','stamp')`).run();
    const before = legacySnapshot(db);

    applyAll(db);
    assert.deepEqual(legacySnapshot(db), before, "Worker migrations must preserve matches columns and rows exactly");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mam_%' ORDER BY name")
      .all().map(row => row.name);
    assert.deepEqual(tables, [
      "mam_b_active_generation", "mam_b_fixture_staging", "mam_b_generation_items", "mam_b_generations", "mam_b_live_overlay",
      "mam_b_payloads", "mam_daily_history_retry_state", "mam_team_identities", "mam_team_identity_review_queue", "mam_team_match_links",
      "mam_team_names", "mam_team_provider_ids", "mam_verified_history_matches"
    ]);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

    const once = schemaSnapshot(db);
    applyAll(db);
    assert.deepEqual(schemaSnapshot(db), once, "IF NOT EXISTS migrations must not create duplicate objects on rerun");
    assert.deepEqual(legacySnapshot(db), before, "rerunning migrations must still preserve the legacy archive");
  } finally {
    db.close();
  }
});
