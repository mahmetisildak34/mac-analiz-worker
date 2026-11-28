import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../worker.js";

function memoryD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE matches (
    source TEXT NOT NULL, fixture_id TEXT NOT NULL, league_id TEXT, league_name TEXT, country TEXT,
    kickoff TEXT, status TEXT, home_team_id TEXT, home_team TEXT, away_team_id TEXT, away_team TEXT,
    home_goals INTEGER, away_goals INTEGER, statistics_json TEXT, raw_json TEXT, updated_at TEXT,
    PRIMARY KEY(source, fixture_id)
  )`);
  return {
    sqlite,
    prepare(sql) {
      return { sql, values: [], bind(...values) { this.values = values; return this; },
        async run() { const result = sqlite.prepare(sql).run(...this.values); return { success: true, meta: { changes: result.changes } }; },
        async first() { return sqlite.prepare(sql).get(...this.values) || null; } };
    },
    async batch(statements) {
      return statements.map(({sql, values}) => {
        const result = sqlite.prepare(sql).run(...values);
        return { success: true, meta: { changes: result.changes } };
      });
    }
  };
}

function payload(status, home, away, source = "espn") {
  return { matches: [{
    mamSource: source,
    fixture: { id: "401888241", date: "2026-11-27T17:00:00Z", status: { short: status } },
    league: { id: 203, name: "Süper Lig", country: "Türkiye" },
    teams: { home: { name: "Alanyaspor" }, away: { name: "Konyaspor" } },
    goals: { home, away }, mamVerifiedHistoricalFinal: true
  }] };
}
async function sessionToken(secret) {
  const payload = Buffer.from(JSON.stringify({v: 1, exp: Date.now() + 60_000})).toString("base64url");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))).toString("base64url");
  return `${payload}.${signature}`;
}
async function post(DB, body, token) {
  return worker.fetch(new Request("https://mam-worker.test/api/archive/matches", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://mahmetisildak34.github.io", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  }), { DB, SESSION_SECRET: "test-only-secret" });
}

test("real archive/matches POST handler canonicalizes source and never regresses a completed score", async () => {
  const DB = memoryD1();
  const {sqlite} = DB;
  const token = await sessionToken("test-only-secret");
  try {
    const unauthenticated = await worker.fetch(new Request("https://mam-worker.test/api/archive/matches", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://mahmetisildak34.github.io" },
      body: JSON.stringify(payload("FT", 1, 2, "espn"))
    }), { DB, SESSION_SECRET: "test-only-secret" });
    assert.equal(unauthenticated.status, 401, "archive write must retain signed-session authentication");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM matches").get().n, 0, "unauthenticated write must not persist rows");
    assert.equal((await post(DB, payload("FT", 1, 2, "espn"), token)).status, 200);
    assert.equal((await post(DB, payload("LIVE", 0, 0, "ESPN"), token)).status, 200);
    assert.equal((await post(DB, payload("NS", null, null, "eSpN"), token)).status, 200);
    const rows = sqlite.prepare("SELECT source, status, home_goals, away_goals FROM matches").all();
    assert.deepEqual(rows.map(row => ({...row})), [{ source: "ESPN", status: "FT", home_goals: 1, away_goals: 2 }]);
    assert.equal((await post(DB, payload("FT", 3, 0, "untrusted-client-source"), token)).status, 200);
    const app = sqlite.prepare("SELECT source,status,home_goals,away_goals FROM matches WHERE source='APP'").get();
    assert.deepEqual({...app}, { source: "APP", status: "FT", home_goals: 3, away_goals: 0 });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM matches WHERE source='ESPN'").get().n, 1);
  } finally { sqlite.close(); }
});

test("statistics-only archive route is authenticated and cannot change match status or score", async () => {
  const DB = memoryD1(), { sqlite } = DB, token = await sessionToken("test-only-secret");
  try {
    sqlite.prepare(`INSERT INTO matches(source,fixture_id,league_id,kickoff,status,home_team,away_team,home_goals,away_goals)
      VALUES('ESPN','live-1','203','2026-11-27T17:00:00Z','LIVE','Alanyaspor','Konyaspor',0,0)`).run();
    const makeRequest = (body, auth) => worker.fetch(new Request("https://mam-worker.test/api/archive/statistics", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://mahmetisildak34.github.io", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      body: JSON.stringify(body)
    }), { DB, SESSION_SECRET: "test-only-secret" });
    assert.equal((await makeRequest({ source: "ESPN", fixtureId: "live-1", statistics: { shots: 10 } })).status, 401);
    assert.equal((await makeRequest({ source: "ESPN", fixtureId: "live-1", statistics: { shots: 10 }, status: "FT" }, token)).status, 400);
    const response = await makeRequest({ source: "espn", fixtureId: "live-1", statistics: { shots: 10 } }, token);
    assert.equal(response.status, 200);
    assert.deepEqual({ ...(await response.json()) }, { ok: true, updated: 1 });
    const row = sqlite.prepare("SELECT status,home_goals,away_goals,statistics_json FROM matches WHERE fixture_id='live-1'").get();
    assert.deepEqual({ status: row.status, home_goals: row.home_goals, away_goals: row.away_goals, statistics: JSON.parse(row.statistics_json) },
      { status: "LIVE", home_goals: 0, away_goals: 0, statistics: { shots: 10 } });
  } finally { sqlite.close(); }
});
