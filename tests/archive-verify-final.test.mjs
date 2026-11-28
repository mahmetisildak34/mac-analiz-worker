import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../worker.js";

function makeDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE matches (
    source TEXT NOT NULL, fixture_id TEXT NOT NULL, league_id TEXT NOT NULL, league_name TEXT, country TEXT,
    kickoff TEXT NOT NULL, status TEXT NOT NULL, home_team_id TEXT, home_team TEXT, away_team_id TEXT,
    away_team TEXT, home_goals INTEGER, away_goals INTEGER, statistics_json TEXT, raw_json TEXT,
    updated_at TEXT, PRIMARY KEY(source,fixture_id)
  )`);
  sqlite.exec(readFileSync(new URL("../migrations/0008_verified_archive_corrections.sql", import.meta.url), "utf8"));
  return {
    sqlite,
    prepare(sql) {
      return { sql, args: [], bind(...args) { this.args = args; return this; },
        async first() { return sqlite.prepare(sql).get(...this.args) || null; },
        async run() { const result = sqlite.prepare(sql).run(...this.args); return { success: true, meta: { changes: result.changes } }; } };
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const rows = statements.map(statement => {
          const result = sqlite.prepare(statement.sql).run(...statement.args);
          return { success: true, meta: { changes: result.changes } };
        });
        sqlite.exec("COMMIT");
        return rows;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    }
  };
}
async function signedToken(secret) {
  const payload = Buffer.from(JSON.stringify({ v: 1, exp: Date.now() + 60_000 })).toString("base64url");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))).toString("base64url");
  return `${payload}.${signature}`;
}
function scoreboardEvent({ complete = true, score = [1, 2] } = {}) {
  return { id: "espn-verified-event-1", date: "2026-11-27T17:00:00Z", status: { type: { completed: complete } }, competitions: [{ competitors: [
    { homeAway: "home", team: { displayName: "Alanyaspor" }, score: String(score[0]) },
    { homeAway: "away", team: { displayName: "Konyaspor" }, score: String(score[1]) }
  ] }] };
}
async function request(DB, body, token) {
  const headers = { "Content-Type": "application/json", Origin: "https://mahmetisildak34.github.io" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return worker.fetch(new Request("https://mam-worker.test/api/archive/verify-final", { method: "POST", headers, body: JSON.stringify(body) }), { DB, SESSION_SECRET: "verify-test-secret" });
}
function addRow(DB, { fixtureId = "legacy-1", status = "LIVE", home = "Alanyaspor", away = "Konyaspor", homeGoals = 0, awayGoals = 0 } = {}) {
  DB.sqlite.prepare(`INSERT INTO matches(source,fixture_id,league_id,kickoff,status,home_team,away_team,home_goals,away_goals)
    VALUES('app',?,'203','2026-11-27T17:00:00Z',?,?,?, ?,?)`).run(fixtureId, status, home, away, homeGoals, awayGoals);
}

test("verify-final requires session, accepts only a reference, and records provider-verified result once", async () => {
  const DB = makeDb(), token = await signedToken("verify-test-secret");
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async url => {
    providerCalls++;
    return new Response(JSON.stringify({ events: String(url).includes("dates=20261127") ? [scoreboardEvent()] : [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    addRow(DB);
    const unauth = await request(DB, { leagueId: "203", source: "app", fixtureId: "legacy-1" });
    assert.equal(unauth.status, 401);
    const extra = await request(DB, { leagueId: "203", source: "app", fixtureId: "legacy-1", mamVerifiedHistoricalFinal: true }, token);
    assert.equal(extra.status, 400, "the client cannot pass a verified-score flag or score payload");
    const body = { leagueId: "203", source: "app", fixtureId: "legacy-1" };
    const response = await request(DB, body, token);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, verified: true, source: "ESPN", eventId: "espn-verified-event-1", score: [1, 2] });
    const row = DB.sqlite.prepare("SELECT source,status,home_goals,away_goals FROM matches WHERE fixture_id='legacy-1'").get();
    assert.deepEqual({ ...row }, { source: "app", status: "FT", home_goals: 1, away_goals: 2 });
    assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM mam_archive_corrections").get().n, 1);
    assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM mam_archive_verify_quota").get().n, 1);
    const callsAfterVerify = providerCalls;
    const repeated = await request(DB, body, token);
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).cached, true);
    assert.equal(providerCalls, callsAfterVerify, "persisted provider evidence prevents a repeat upstream lookup");
  } finally { globalThis.fetch = originalFetch; DB.sqlite.close(); }
});

test("verify-final refuses unfinished and mismatched provider events and enforces the daily budget before fetch", async () => {
  const DB = makeDb(), token = await signedToken("verify-test-secret"), originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async url => {
    providerCalls++;
    const event = String(url).includes("dates=20261127") ? scoreboardEvent({ complete: false }) : null;
    return new Response(JSON.stringify({ events: event ? [event] : [] }), { status: 200 });
  };
  try {
    addRow(DB, { fixtureId: "unfinished" });
    const body = { leagueId: "203", source: "APP", fixtureId: "unfinished" };
    const response = await request(DB, body, token);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, verified: false, reason: "no_completed_provider_match" });
    assert.equal(DB.sqlite.prepare("SELECT status,home_goals,away_goals FROM matches WHERE fixture_id='unfinished'").get().status, "LIVE");
    assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM mam_archive_corrections").get().n, 0);
    addRow(DB, { fixtureId: "wrong-teams", home: "Paris FC", away: "Inter Miami" });
    const mismatched = await request(DB, { leagueId: "203", source: "APP", fixtureId: "wrong-teams" }, token);
    assert.deepEqual(await mismatched.json(), { ok: true, verified: false, reason: "no_completed_provider_match" });
    const untouched = DB.sqlite.prepare("SELECT status,home_goals,away_goals FROM matches WHERE fixture_id='wrong-teams'").get();
    assert.deepEqual({ ...untouched }, { status: "LIVE", home_goals: 0, away_goals: 0 });
    assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM mam_archive_corrections").get().n, 0);
    const today = new Date().toISOString().slice(0, 10);
    DB.sqlite.prepare("UPDATE mam_archive_verify_quota SET used=50 WHERE day=?").run(today);
    const callsBeforeLimit = providerCalls;
    const limited = await request(DB, body, token);
    assert.equal(limited.status, 429);
    assert.equal(providerCalls, callsBeforeLimit, "daily budget is enforced before any provider fetch");
  } finally { globalThis.fetch = originalFetch; DB.sqlite.close(); }
});
