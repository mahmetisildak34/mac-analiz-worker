import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const worker = fs.readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const sqlLine = worker.split("\n").find(line => line.includes('const sql = "INSERT INTO matches'));
assert.ok(sqlLine, "archive upsert SQL must be present");
const sql = sqlLine.slice(sqlLine.indexOf('"') + 1, sqlLine.lastIndexOf('";'));

function dbWithSchema() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE matches (
    source TEXT NOT NULL, fixture_id TEXT NOT NULL, league_id TEXT, league_name TEXT,
    country TEXT, kickoff TEXT, status TEXT, home_team_id TEXT, home_team TEXT,
    away_team_id TEXT, away_team TEXT, home_goals INTEGER, away_goals INTEGER,
    statistics_json TEXT, raw_json TEXT, updated_at TEXT, PRIMARY KEY(source,fixture_id)
  )`);
  return db;
}

const values = (status, homeId, awayId, homeName, awayName, homeGoals, awayGoals, raw) => [
  "ESPN", "espn-test-1", "39", "Premier League", "England", "2026-11-27T20:00:00Z",
  status, homeId, homeName, awayId, awayName, homeGoals, awayGoals, null, raw
];

test("archive upsert preserves final score and trusted identity fields on incomplete replay", () => {
  const db = dbWithSchema();
  try {
    const upsert = db.prepare(sql);
    upsert.run(...values("FT", "100", "200", "Alpha FC", "Beta FC", 2, 1, '{"complete":true}'));
    upsert.run(...values("NS", null, null, "", "", null, null, null));
    const row = db.prepare("SELECT status,home_team_id,away_team_id,home_team,away_team,home_goals,away_goals,raw_json FROM matches").get();
    assert.equal(row.status, "FT");
    assert.equal(row.home_team_id, "100");
    assert.equal(row.away_team_id, "200");
    assert.equal(row.home_team, "Alpha FC");
    assert.equal(row.away_team, "Beta FC");
    assert.equal(row.home_goals, 2);
    assert.equal(row.away_goals, 1);
    assert.equal(row.raw_json, '{"complete":true}');
    upsert.run(...values("FT", "100", "200", "Alpha FC", "Beta FC", 3, 1, '{"corrected":true}'));
    assert.deepEqual({ ...db.prepare("SELECT status,home_goals,away_goals FROM matches").get() },
      { status: "FT", home_goals: 3, away_goals: 1 });
  } finally {
    db.close();
  }
});
