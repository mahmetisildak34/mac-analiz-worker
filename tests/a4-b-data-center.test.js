const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const appRoot = process.env.MAM_APP_ROOT;
if (!appRoot) throw new Error("Set MAM_APP_ROOT to the PR #98 app checkout for this isolated integration test.");
const core = require(path.join(appRoot, "match-data-center.js"));
const identityApi = require(path.join(appRoot, "team-identity-registry.js"));
const { loadPreparedAnalysis } = require(path.join(appRoot, "data-center-client.js"));
const { DAILY_B_CRON_UTC, createWorkerBLayer } = require("../a4-b-data-center-adapter.js");
const stamp = "2026-11-26T21:02:00.000Z";

class LocalD1 {
  constructor(db) { this.db = db; this.failNextBatch = false; this.failNextRead = false; }
  prepare(sql) {
    const owner = this;
    let values = [];
    const stmt = {
      bind(...args) { values = args; return stmt; },
      all() {
        if (owner.failNextRead) { owner.failNextRead = false; throw Error("injected D1 read failure"); }
        return { results: owner.db.prepare(sql).all(...values) };
      },
      first() {
        if (owner.failNextRead) { owner.failNextRead = false; throw Error("injected D1 read failure"); }
        return owner.db.prepare(sql).get(...values) || null;
      },
      run() { return { meta: { changes: Number(owner.db.prepare(sql).run(...values).changes) } }; }
    };
    Object.defineProperty(stmt, "sql", { value: sql });
    Object.defineProperty(stmt, "values", { get: () => values });
    return stmt;
  }
  async batch(statements) {
    if (this.failNextBatch) { this.failNextBatch = false; throw Error("injected D1 batch failure"); }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map(statement => {
        const result = this.db.prepare(statement.sql).run(...statement.values);
        return { meta: { changes: Number(result.changes) } };
      });
      this.db.exec("COMMIT");
      return results;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

function setup() {
  const db = new DatabaseSync(":memory:");
  for (const file of ["team-identity-v1.sql", "daily-history-v1.sql", "match-data-center-v1.sql"])
    db.exec(fs.readFileSync(path.join(appRoot, "schema", file), "utf8"));
  db.exec(`CREATE TABLE matches (
    source TEXT NOT NULL, fixture_id TEXT NOT NULL, league_id TEXT NOT NULL, league_name TEXT,
    country TEXT, kickoff TEXT NOT NULL, status TEXT NOT NULL, home_team_id TEXT, home_team TEXT,
    away_team_id TEXT, away_team TEXT, home_goals INTEGER, away_goals INTEGER,
    statistics_json TEXT, raw_json TEXT, updated_at TEXT, PRIMARY KEY(source,fixture_id)
  );`);
  const d1 = new LocalD1(db);
  return { db, d1, layer: createWorkerBLayer({ DB: d1, core, identityApi, now: () => stamp }) };
}

function addIdentity(db, teamId, currentName, alternateName, providerTeamId) {
  db.prepare("INSERT INTO mam_team_identities(team_id,country_code,created_at,updated_at) VALUES(?,?,?,?)")
    .run(teamId, "GB", stamp, stamp);
  const names = [[currentName, "current"], ...(alternateName ? [[alternateName, "alternate"]] : [])];
  for (const [index, [name, type]] of names.entries()) db.prepare(`INSERT INTO mam_team_names
    (name_id,team_id,display_name,normalized_name,name_type,verified,source,valid_from,valid_to,verified_at,approved_by)
    VALUES(?,?,?,?,?,1,'fixture-test','2000-01-01',NULL,?,'test-reviewer')`)
    .run(`${teamId}:name:${index}`, teamId, name, identityApi.normalizeTeamName(name), type, stamp);
  if (providerTeamId) db.prepare(`INSERT INTO mam_team_provider_ids
    (provider,provider_team_id,team_id,verified,source,valid_from,valid_to,verified_at,approved_by)
    VALUES('ESPN',?,?,1,'fixture-test','2000-01-01',NULL,?,'test-reviewer')`)
    .run(String(providerTeamId), teamId, stamp);
}

function addArchiveMatch(db, { source = "ESPN", fixtureId, leagueId, kickoff, homeId, awayId, homeName, awayName, homeScore = 1, awayScore = 0, verifiedStats = false }) {
  db.prepare(`INSERT INTO matches(source,fixture_id,league_id,league_name,country,kickoff,status,home_team_id,home_team,
    away_team_id,away_team,home_goals,away_goals,statistics_json,raw_json,updated_at)
    VALUES(?,?,?,'Test League','England',?,'FT','11',?,'22',?,?,?, ?,?,?)`)
    .run(source, fixtureId, leagueId, kickoff, homeName, awayName, homeScore, awayScore,
      JSON.stringify(verifiedStats ? [{ name: "corners", value: 7, provider: source, source: "verified test feed", verified: true }] : []),
      JSON.stringify({ score: { halftime: { home: 1, away: 0 } } }), stamp);
  const day = kickoff.slice(0, 10);
  for (const [side, teamId, rawName, providerTeamId] of [["home", homeId, homeName, "11"], ["away", awayId, awayName, "22"]])
    db.prepare(`INSERT INTO mam_team_match_links(provider,provider_fixture_id,side,match_date,team_id,provider_team_id,
      raw_team_name,verified_at,verification_source,approved_by) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .run(source, fixtureId, side, day, teamId, providerTeamId, rawName, stamp, "verified test source", "test-reviewer");
}

function seedTeamHistory(db, team) {
  addIdentity(db, team.id, team.name, team.alias, team.providerId);
  addIdentity(db, team.opponentId, team.opponentName, null, null);
  for (let i = 0; i < 10; i++) {
    const day = String(15 - i).padStart(2, "0");
    const competition = ["39", "40", "45", "48", "203"][i % 5];
    const isHome = i % 2 === 0;
    const homeId = isHome ? team.id : team.opponentId;
    const awayId = isHome ? team.opponentId : team.id;
    const homeName = isHome ? team.name : team.opponentName;
    const awayName = isHome ? team.opponentName : team.name;
    addArchiveMatch(db, { fixtureId: `${team.slug}-${i}`, leagueId: competition,
      kickoff: `2026-11-${day}T15:00:00Z`, homeId, awayId, homeName, awayName, verifiedStats: i === 0 });
    if (i === 0) addArchiveMatch(db, { source: "ESPN_COPY", fixtureId: `${team.slug}-copy-${i}`, leagueId: competition,
      kickoff: `2026-11-${day}T15:00:00Z`, homeId, awayId, homeName, awayName, verifiedStats: true });
  }
}

function fixtures() {
  return [
    { provider: "ESPN", providerFixtureId: "bournemouth-next", competitionId: "3", kickoff: "2026-11-27T15:00:00Z", status: "scheduled",
      home: { provider: "ESPN", providerTeamId: "349", name: "Bournemouth", countryCode: "GB" },
      away: { name: "Reading FC", countryCode: "GB" } },
    { provider: "ESPN", providerFixtureId: "plzen-next", competitionId: "39", kickoff: "2026-11-28T15:00:00Z", status: "scheduled",
      home: { provider: "ESPN", providerTeamId: "301", name: "Plzeň", countryCode: "GB" },
      away: { name: "Test Opponent Plzen", countryCode: "GB" } },
    { provider: "ESPN", providerFixtureId: "mjallby-next", competitionId: "203", kickoff: "2026-11-29T15:00:00Z", status: "scheduled",
      home: { provider: "ESPN", providerTeamId: "401", name: "Mjällby", countryCode: "GB" },
      away: { name: "Test Opponent Mjallby", countryCode: "GB" } }
  ];
}

function seedAll(db) {
  seedTeamHistory(db, { id: "team:bournemouth", slug: "bou", name: "AFC Bournemouth", alias: "Bournemouth", providerId: "349",
    opponentId: "team:bou-opponent", opponentName: "Reading FC" });
  seedTeamHistory(db, { id: "team:plzen", slug: "plz", name: "Viktoria Plzeň", alias: "Plzeň", providerId: "301",
    opponentId: "team:plz-opponent", opponentName: "Test Opponent Plzen" });
  seedTeamHistory(db, { id: "team:mjallby", slug: "mja", name: "Mjällby AIF", alias: "Mjällby", providerId: "401",
    opponentId: "team:mja-opponent", opponentName: "Test Opponent Mjallby" });
}

function input(extra = {}) { return { generatedAt: stamp, scopeComplete: true,
  expectedCompetitionIds: ["3", "39", "203"], loadedCompetitionIds: ["3", "39", "203"], fixtures: fixtures(), ...extra }; }

test("isolated Worker adapter reads approved A links across leagues and prepares Bournemouth, Plzen, and Mjällby", async () => {
  assert.equal(DAILY_B_CRON_UTC, "1 21 * * *");
  const { db, layer } = setup();
  try {
    seedAll(db);
    const prepared = await layer.prepareByCompetition(input());
    assert.equal(prepared.scopeComplete, true);
    assert.equal(prepared.outcomes.filter(item => item.status === "loaded").length, 3);
    assert.equal(prepared.records.filter(item => item.kind === "fixture").length, 3);
    for (const teamId of ["team:bournemouth", "team:plzen", "team:mjallby"]) {
      const analysis = prepared.records.find(item => item.key.startsWith(`team-analysis:${teamId}:`));
      assert.ok(analysis, `expected analysis bundle for ${teamId}`);
      assert.equal(analysis.payload.historyCount, 10);
      assert.ok(new Set(analysis.payload.history.map(item => item.competitionId)).size > 1,
        `${teamId} history must combine more than one competition`);
    }
    const bournemouth = prepared.records.find(item => item.key.startsWith("team-analysis:team:bournemouth:"));
    assert.equal(bournemouth.payload.history[0].halftime.homeScore, 1);
    assert.ok(bournemouth.payload.history[0].statistics.some(item => item.name === "corners"));
  } finally { db.close(); }
});

test("active B bundle read returns only the exact fixture and its two referenced ten-match analyses", async () => {
  const { db, layer } = setup();
  try {
    seedAll(db);
    await layer.publish(input());
    const result = await layer.readFixtureBundle("espn:bournemouth-next");
    assert.equal(result.fixture.providerFixtureId, "bournemouth-next");
    assert.equal(result.analyses.home.payload.historyCount, 10);
    assert.equal(result.analyses.away.payload.historyCount, 10);
    assert.equal(result.analyses.home.key, result.fixture.teamAnalysisKeys.home);
    assert.equal(result.analyses.away.key, result.fixture.teamAnalysisKeys.away);
    assert.equal(await layer.readFixtureBundle("espn:not-present"), null);
  } finally { db.close(); }
});

test("isolated D1-to-Worker-to-app-client flow supplies prepared histories and falls back on absent bundle", async () => {
  const { db, layer } = setup();
  try {
    seedAll(db);
    await layer.publish(input());
    const request = { provider: "espn", fixtureId: "bournemouth-next", kickoff: "2026-11-27T15:00:00Z",
      homeTeamId: "349", awayTeamId: "0" };
    const fetchBundle = ({ provider, fixtureId }) => layer.readFixtureBundle(`${provider}:${fixtureId}`);
    const prepared = await loadPreparedAnalysis(fetchBundle, request);
    assert.equal(prepared.source, "prepared");
    assert.equal(prepared.homeHistory.length, 10);
    assert.equal(prepared.awayHistory.length, 10);
    assert.equal(prepared.homeHistory[0].teams.home.id, 349);
    assert.equal(await loadPreparedAnalysis(async () => null, request), null);
  } finally { db.close(); }
});

test("daily B preparation reads an upcoming A fixture without provider calls and is diff-idempotent", async () => {
  const { db, d1, layer } = setup();
  try {
    seedAll(db);
    db.prepare(`INSERT INTO matches(source,fixture_id,league_id,league_name,country,kickoff,status,home_team_id,home_team,
      away_team_id,away_team,raw_json,updated_at) VALUES('ESPN','bournemouth-next','3','Test League','England',
      '2026-11-27T15:00:00Z','NS','349','Bournemouth',NULL,'Reading FC',?,?)`)
      .run(JSON.stringify({ teams: { home: { id: "349", name: "Bournemouth" }, away: { name: "Reading FC" } } }), stamp);
    const first = await layer.prepareFromD1Upcoming();
    assert.equal(first.readyFixtures, 1);
    const second = await layer.prepareFromD1Upcoming();
    assert.equal(second.noOp, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM mam_b_generations").get().n, 1);
  } finally { db.close(); }
});

test("one competition read failure preserves its previous B bundle while healthy competitions update", async () => {
  const { db, layer } = setup();
  try {
    seedAll(db);
    const first = await layer.publish(input());
    const prior = first.generationId;
    const second = await layer.publish(input({ generatedAt: "2026-11-26T21:03:00.000Z",
      fixtures: [...fixtures(), { ...fixtures()[0], providerFixtureId: "bournemouth-next-healthy-update",
        kickoff: "2026-11-30T15:00:00Z" }],
      competitionLoadErrors: { "39": "synthetic league read failure" } }));
    assert.notEqual(second.generationId, prior);
    assert.deepEqual(second.preservedCompetitions, ["39"]);
    assert.equal(second.outcomes.find(item => item.competitionId === "39").status, "preserved_previous");
    const active = db.prepare("SELECT generation_id FROM mam_b_active_generation WHERE singleton=1").get();
    const preserved = db.prepare(`SELECT p.payload_json FROM mam_b_generation_items i JOIN mam_b_payloads p USING(payload_hash)
      WHERE i.generation_id=? AND i.item_key='fixture:espn:plzen-next'`).get(active.generation_id);
    assert.ok(preserved, "previously verified fixture for failed competition remains in the active generation");
    assert.equal(JSON.parse(preserved.payload_json).competitionId, "39");
    assert.ok(db.prepare("SELECT 1 FROM mam_b_generation_items WHERE generation_id=? AND item_key='fixture:espn:bournemouth-next'")
      .get(active.generation_id), "healthy competition fixture is present");
    assert.ok(db.prepare("SELECT 1 FROM mam_b_generation_items WHERE generation_id=? AND item_key='fixture:espn:bournemouth-next-healthy-update'")
      .get(active.generation_id), "new healthy competition fixture is published");
  } finally { db.close(); }
});

test("missing B item or B read error uses the caller's legacy fallback", async () => {
  const { db, d1, layer } = setup();
  try {
    let called = 0;
    const fallback = async key => { called++; return { fixtureKey: key, legacy: true }; };
    const missing = await layer.readFixtureOrFallback("not-in-b", fallback);
    assert.equal(missing.source, "legacy");
    d1.failNextRead = true;
    const failedRead = await layer.readFixtureOrFallback("anything", fallback);
    assert.equal(failedRead.source, "legacy");
    assert.equal(called, 2);
  } finally { db.close(); }
});

test("failed D1 staging batch leaves the prior active generation intact", async () => {
  const { db, d1, layer } = setup();
  try {
    seedAll(db);
    const first = await layer.publish(input());
    d1.failNextBatch = true;
    await assert.rejects(layer.publish(input({ generatedAt: "2026-11-26T21:04:00.000Z",
      fixtures: [...fixtures(), { ...fixtures()[0], providerFixtureId: "bournemouth-commit-failure" }] })), /injected D1 batch failure/);
    assert.equal(db.prepare("SELECT generation_id FROM mam_b_active_generation WHERE singleton=1").get().generation_id, first.generationId);
    assert.equal(db.prepare("SELECT status FROM mam_b_generations WHERE generation_id=?").get(first.generationId).status, "active");
  } finally { db.close(); }
});

test("compare-and-swap rejects a stale publisher without displacing a newer active generation", async () => {
  const { db, d1, layer } = setup();
  try {
    seedAll(db);
    const first = await layer.publish(input());
    const staleAdapter = createWorkerBLayer({ DB: d1, core, identityApi, now: () => stamp });
    await staleAdapter.storageAdapter.loadActiveItems();
    const second = await layer.publish(input({ generatedAt: "2026-11-26T21:05:00.000Z",
      fixtures: [...fixtures(), { ...fixtures()[0], providerFixtureId: "bournemouth-newer-writer" }] }));
    await assert.rejects(staleAdapter.storageAdapter.atomicCommit({ generationId: "stale-candidate",
      manifest: { generatedAt: "2026-11-26T21:06:00.000Z" }, items: [] }), /stale_generation_compare_and_swap/);
    assert.equal(db.prepare("SELECT generation_id FROM mam_b_active_generation WHERE singleton=1").get().generation_id, second.generationId);
    assert.equal(db.prepare("SELECT status FROM mam_b_generations WHERE generation_id=?").get(first.generationId).status, "retired");
  } finally { db.close(); }
});

test("live overlay preserves the B base, rejects stale/unverified updates, and never invents precise seconds", async () => {
  const { db, layer } = setup();
  try {
    seedAll(db);
    await layer.publish(input());
    const accepted = await layer.applyLiveUpdate({ fixtureKey: "espn:bournemouth-next", provider: "ESPN", providerVerified: true,
      status: "live", observedAt: "2026-11-27T15:30:00.000Z", homeScore: 1, awayScore: 0,
      minuteLabel: "30", clockPrecise: false, elapsedSeconds: 1800,
      statistics: [{ name: "shots", value: 4, provider: "ESPN", verified: true }] });
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.normalized.elapsedSeconds, null);
    assert.equal(accepted.normalized.clockPrecise, false);
    assert.equal((await layer.applyLiveUpdate({ fixtureKey: "espn:bournemouth-next", provider: "ESPN", providerVerified: false,
      status: "live", observedAt: "2026-11-27T15:31:00.000Z", homeScore: 2, awayScore: 0 })).accepted, false);
    assert.equal((await layer.applyLiveUpdate({ fixtureKey: "espn:bournemouth-next", provider: "ESPN", providerVerified: true,
      status: "live", observedAt: "2026-11-27T15:29:00.000Z", homeScore: 0, awayScore: 0 })).accepted, false);
    const view = await layer.readFixture("espn:bournemouth-next");
    assert.equal(view.base.status, "scheduled");
    assert.equal(view.live.home_score, 1);
    assert.equal(view.live.elapsed_seconds, null);
    assert.equal(view.live.minute_label, "30");
  } finally { db.close(); }
});
