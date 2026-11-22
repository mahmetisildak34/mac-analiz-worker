import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runInNewContext } from "node:vm";

const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const archive = worker.slice(worker.indexOf("const ESPN_ARCHIVE_AUDIT_DAYS"), worker.indexOf("async function buildPriorityLeagueStatus"));
const conferenceLeague = ["848", "uefa.europa.conf", "UEFA Conference League", "Europe"];

test("archive prioritizes the audit window without changing processed jobs or dropping retries", () => {
  const prioritize = runInNewContext(archive + "\nprioritizeEspnArchiveJobs");
  const processed = { date: "20261001", league: conferenceLeague };
  const historical = { date: "20260101", league: conferenceLeague };
  const retry = { date: "20261123", league: conferenceLeague, attempts: 1 };
  const due = { date: "20261217", league: conferenceLeague };
  const outside = { date: "20261223", league: conferenceLeague };
  const state = { jobs: [processed, historical, retry, due, outside], cursor: 1 };

  const now = new Date("2026-11-22T13:00:00Z");
  const shouldReconcile = prioritize(state, now);
  assert.equal(shouldReconcile(processed), true);
  assert.equal(shouldReconcile(historical), false);
  assert.equal(shouldReconcile(due), true);
  const expected = [processed, due, { ...processed, attempts: 0 }, historical, retry, outside];
  const jobKeys = () => Array.from(state.jobs, job => [job.date, job.attempts]);
  assert.deepEqual(jobKeys(), expected.map(job => [job.date, job.attempts]));
  prioritize(state, now);
  assert.deepEqual(jobKeys(), expected.map(job => [job.date, job.attempts]));
  assert.equal(state.cursor, 1);
});

test("ESPN coverage sync fills a partial upcoming matchday and preserves existing stats", async () => {
  const now = new Date("2026-11-22T13:00:00Z");
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now.getTime()])); }
    static now() { return now.getTime(); }
  }
  const kickoff = "2026-12-17T20:00Z";
  // The ESPN December scoreboard lists these 18 fixtures on the same matchday.
  const events = [
    ["401915731", "139", "Ajax Amsterdam", "2922", "Getafe"],
    ["401915627", "174", "AS Monaco", "17856", "Lincoln Red Imps"],
    ["401915626", "105", "Atalanta", "20301", "Mjällby AIF"],
    ["401915623", "20710", "Borac Banja Luka", "19246", "Riga FC"],
    ["401915614", "2994", "Braga", "21943", "Egnatia"],
    ["401915615", "10834", "CSKA Sofia", "3024", "FC Thun"],
    ["401915613", "8089", "CSU Craiova", "909", "F.C. København"],
    ["401915625", "7672", "FC Lugano", "936", "Sint-Truidense"],
    ["401915730", "572", "FC Midtjylland", "489", "Hajduk Split"],
    ["401915729", "3101", "FC Nordsjælland", "8169", "KuPS Kuopio"],
    ["401915624", "152", "FC Twente", "2528", "Kairat Almaty"],
    ["401915619", "20703", "Inter D'Escaldes", "7853", "AGF"],
    ["401915621", "7922", "Jablonec", "20025", "Iberia 1999"],
    ["401915618", "3611", "KAA Gent", "620", "SK Brann"],
    ["401915620", "20028", "Kauno Zalgiris", "126", "SC Freiburg"],
    ["401915617", "22281", "Pafos", "262", "Heart of Midlothian"],
    ["401915616", "443", "Panathinaikos", "331", "Brighton & Hove Albion"],
    ["401915622", "2290", "Red Star Belgrade", "997", "Trabzonspor"],
  ].map(([id, homeId, home, awayId, away]) => ({
    id, date: kickoff, status: { type: { state: "pre" } },
    competitions: [{ competitors: [
      { homeAway: "home", team: { id: homeId, displayName: home } },
      { homeAway: "away", team: { id: awayId, displayName: away } },
    ] }],
  }));
  const fixtureId = "espn-uefa.europa.conf-" + events[0].id;
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE matches (
      source TEXT, fixture_id TEXT, league_id TEXT, league_name TEXT, country TEXT,
      kickoff TEXT, status TEXT, home_team_id TEXT, home_team TEXT, away_team_id TEXT,
      away_team TEXT, home_goals INTEGER, away_goals INTEGER, statistics_json TEXT,
      raw_json TEXT, updated_at TEXT, PRIMARY KEY(source, fixture_id)
    )`);
    database.prepare(`INSERT INTO matches
      (source, fixture_id, league_id, kickoff, status, statistics_json)
      VALUES ('ESPN', ?, '848', ?, 'NS', '{"retained":true}')`).run(fixtureId, kickoff);
    const values = new Map([
      ["mam:espn-sync-state:v2", { cursor: 0, jobs: [
        { league: conferenceLeague, date: "20261101" },
        { league: conferenceLeague, date: "20261217" },
      ] }],
      ["mam:espn-summary-queue:v1", []],
      ["mam:espn-summary-deferred:v1", []],
    ]);
    const requests = [];
    const sync = runInNewContext(archive + "\nsyncEspnFixturesToD1", {
      Date: FixedDate, ESPN_BASE: "https://site.api.espn.com/apis/site/v2/sports/soccer",
      fetch: async url => {
        requests.push(url);
        return { ok: true, json: async () => ({ events }) };
      },
    });
    const result = await sync({
      MAM_KV: {
        get: async key => values.get(key) ?? null,
        put: async (key, value) => values.set(key, JSON.parse(value)),
        delete: async key => values.delete(key),
      },
      DB: {
        prepare: sql => ({
          bind: (...args) => ({
            all: async () => ({ results: database.prepare(sql).all(...args) }),
            run: () => ({ meta: database.prepare(sql).run(...args) }),
          }),
        }),
        batch: async statements => statements.map(statement => statement.run()),
      },
    }, 45, 30, 1);
    assert.deepEqual(requests, [
      "https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.europa.conf/scoreboard?dates=20261217&limit=500",
    ]);
    assert.equal(result.failed, 0);
    assert.equal(result.saved, events.length);
    assert.deepEqual(database.prepare("SELECT fixture_id FROM matches ORDER BY fixture_id").all()
      .map(row => row.fixture_id), events.map(event => "espn-uefa.europa.conf-" + event.id).sort());
    assert.equal(database.prepare("SELECT statistics_json FROM matches WHERE fixture_id = ?")
      .get(fixtureId).statistics_json, '{"retained":true}');
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM matches WHERE home_goals IS NOT NULL OR away_goals IS NOT NULL")
      .get().count, 0);
    const checkpoint = values.get("mam:espn-sync-state:v2");
    assert.equal(checkpoint.cursor, 1);
    assert.equal(checkpoint.jobs[0].date, "20261217");
    assert.ok(checkpoint.jobs.slice(checkpoint.cursor).some(job => job.date === "20261101" && job.league[0] === "848"));
  } finally {
    database.close();
  }
});
