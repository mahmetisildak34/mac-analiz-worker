import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyEspnEvent, makeIsolatedInsert } from "../espn-isolated-acceptance.mjs";

// Requires the immutable GitHub Actions artifact for run 44912723019.
// No new ESPN HTTP calls. No Cloudflare writes. Never run generated SQL outside the isolated D1.
const input = process.argv[2] || ".espn-source/verified-matches.json";
const outputDir = process.argv[3] || "espn-acceptance-output";
const matches = JSON.parse(fs.readFileSync(input, "utf8"));
assert.equal(matches.length, 4, "historical provider pilot must contain exactly four matches");
const columns = ["source","fixture_id","kickoff","home_team","away_team","home_goals","away_goals",
  "identity_verified","score_verified","statistics_verified","raw_json","statistics_json"];
const unique = new Set();
const sqlLiteral = v => {
  if (v === null || v === undefined) return "NULL";
  if (Number.isSafeInteger(v)) return String(v);
  assert.equal(typeof v, "string");
  assert.ok(!v.includes("\u0000"), "NUL rejected");
  return "'" + v.replaceAll("'", "''") + "'";
};
const sql = [
  "-- Source: GitHub Actions ESPN run 44912723019 artifact 14709783630 (2026-11-07).",
  "-- Execute only on Cloudflare D1 mam-statistics-isolated-test, NEVER Production/Preview.",
  "-- Four idempotent verified ESPN fixtures, no invented statistics."
];
for (const match of matches) {
  assert.equal(match.source, "ESPN");
  assert.equal(match.identity_verified, 1);
  assert.equal(match.score_verified, 1);
  assert.equal(match.statistics_verified, 0);
  assert.equal(match.statistics_json, null);
  assert.match(match.fixture_id, /^espn-eng\.1-\d+$/);
  assert.ok(!unique.has(match.fixture_id), "source duplicate rejected");
  unique.add(match.fixture_id);
  assert.doesNotMatch(match.raw_json, /"(?:authorization|password|api_key|secret|cookie|private_key|access_token|refresh_token)"\s*:/i, "secret-like field");
  const original = JSON.parse(match.raw_json);
  assert.equal(original.status?.type?.completed, true);
  assert.equal(original.date.slice(0, 10), "2026-11-07");
  const verified = verifyEspnEvent(original, "eng.1", "20261107");
  assert.ok(verified, "original ESPN identity not verified");
  for (const key of columns) assert.deepEqual(match[key], verified[key], "original proof mismatch for " + key);
  const prepared = makeIsolatedInsert(match);
  assert.match(prepared.sql, /^INSERT INTO mam_archive_test_matches /);
  assert.match(prepared.sql, /ON CONFLICT\(source,fixture_id\) DO NOTHING$/);
  assert.deepEqual(prepared.params, columns.map(k => match[k]));
  sql.push("INSERT INTO mam_archive_test_matches (" + columns.join(", ") + ") VALUES (" +
    prepared.params.map(sqlLiteral).join(", ") + ") ON CONFLICT(source,fixture_id) DO NOTHING;");
}
sql.push("SELECT COUNT(*) AS verified_pilot_matches FROM mam_archive_test_matches WHERE source='ESPN' AND fixture_id IN (" +
  [...unique].map(sqlLiteral).join(",") + ");");
fs.mkdirSync(outputDir, { recursive: true });
const outputPath = path.join(outputDir, "espn_4_real_matches_isolated_only.sql");
fs.writeFileSync(outputPath, sql.join("\n") + "\n");
// SQLite acceptance tests use the actual original-match data and real generated SQL, never a mock fixture.
const py = [
  "import sqlite3,sys",
  "text=open(sys.argv[1],encoding='utf-8').read()",
  "statements=[line for line in text.splitlines() if line.startswith('INSERT INTO mam_archive_test_matches ')]",
  "assert len(statements)==4",
  "db=sqlite3.connect(':memory:')",
  "db.executescript('CREATE TABLE mam_archive_test_matches (source TEXT NOT NULL, fixture_id TEXT NOT NULL, kickoff TEXT NOT NULL, home_team TEXT NOT NULL, away_team TEXT NOT NULL, home_goals INTEGER, away_goals INTEGER, identity_verified INTEGER NOT NULL DEFAULT 0, score_verified INTEGER NOT NULL DEFAULT 0, statistics_verified INTEGER NOT NULL DEFAULT 0, raw_json TEXT, statistics_json TEXT, PRIMARY KEY(source,fixture_id)); CREATE TABLE mam_archive_test_progress (job_id TEXT PRIMARY KEY, source TEXT NOT NULL, league_id TEXT NOT NULL, season TEXT NOT NULL, cursor TEXT, status TEXT NOT NULL DEFAULT \\'pending\\', attempts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE TABLE mam_archive_test_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, source TEXT NOT NULL, request_url TEXT, error_code TEXT, error_message TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);')",
  "for s in statements[:2]:db.execute(s)",
  "assert db.execute('SELECT COUNT(*) FROM mam_archive_test_matches').fetchone()[0]==2",
  "db.execute('INSERT INTO mam_archive_test_progress (job_id,source,league_id,season,cursor,status,attempts) VALUES (?,?,?,?,?,?,?)',('eng.1-20261107','ESPN','eng.1','2026','2','running',1))",
  "for s in statements:db.execute(s)",
  "assert db.execute('SELECT COUNT(*) FROM mam_archive_test_matches').fetchone()[0]==4",
  "db.execute(\"UPDATE mam_archive_test_progress SET cursor='4',status='completed' WHERE job_id='eng.1-20261107'\")",
  "for s in statements:db.execute(s)",
  "assert db.execute('SELECT COUNT(*) FROM mam_archive_test_matches').fetchone()[0]==4",
  "try:",
  " db.execute(\"INSERT INTO mam_archive_test_matches (source,fixture_id,kickoff,home_team,away_team) VALUES (NULL,'bad','2026-11-07','A','B')\")",
  " raise AssertionError('expected constraint failure')",
  "except sqlite3.IntegrityError:",
  " db.execute('INSERT INTO mam_archive_test_failures (job_id,source,error_code,error_message,attempts) VALUES (?,?,?,?,?)',('eng.1-20261107','ESPN','CONSTRAINT','invalid fixture rejected',1))",
  "assert db.execute('SELECT COUNT(*) FROM mam_archive_test_failures').fetchone()[0]==1",
  "assert db.execute('SELECT status,cursor FROM mam_archive_test_progress').fetchone()==('completed','4')",
  "print('PASS real ESPN 4/4; isolated SQL; duplicate replay 4/4; resume 2->4; failure queue 1/1')"
].join("\n");
console.log(execFileSync("python3", ["-c", py, outputPath], { encoding: "utf8" }).trim());
console.log(JSON.stringify({ original_provider_verified:matches.length, idempotent_sql:outputPath, remote_d1_writes:0 }));
