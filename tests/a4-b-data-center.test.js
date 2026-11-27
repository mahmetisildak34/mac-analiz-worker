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
const workerCore = require("../b-match-data-center.cjs");
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
        const results = owner.db.prepare(sql).all(...values);
        return { results, meta: { rows_read: results.length, rows_written: 0, duration: 0 } };
      },
      first() {
        if (owner.failNextRead) { owner.failNextRead = false; throw Error("injected D1 read failure"); }
        return owner.db.prepare(sql).get(...values) || null;
      },
      run() {
        const changes = Number(owner.db.prepare(sql).run(...values).changes);
        return { meta: { changes, rows_read: 0, rows_written: changes, duration: 0 } };
      }
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
        const changes = Number(result.changes);
        return { meta: { changes, rows_read: 0, rows_written: changes, duration: 0 } };
      });
      this.db.exec("COMMIT");
      return results;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`CREATE TABLE matches (
    source TEXT NOT NULL, fixture_id TEXT NOT NULL, league_id TEXT NOT NULL, league_name TEXT,
    country TEXT, kickoff TEXT NOT NULL, status TEXT NOT NULL, home_team_id TEXT, home_team TEXT,
    away_team_id TEXT, away_team TEXT, home_goals INTEGER, away_goals INTEGER,
    statistics_json TEXT, raw_json TEXT, updated_at TEXT, PRIMARY KEY(source,fixture_id)
  );`);
  db.prepare(`INSERT INTO matches(source,fixture_id,league_id,kickoff,status,home_team,away_team,updated_at)
    VALUES('LEGACY','untouched','test','2020-01-01T12:00:00Z','FT','Home','Away',?)`).run(stamp);
  const legacyBefore = legacyArchiveSnapshot(db);
  const applyMigrations = () => {
    const directory = path.join(__dirname, "..", "migrations");
    const files = fs.readdirSync(directory).filter(file => /^\d+_.*\.sql$/.test(file)).sort();
    for (const file of files) db.exec(fs.readFileSync(path.join(directory, file), "utf8"));
  };
  applyMigrations();
  assert.deepEqual(legacyArchiveSnapshot(db), legacyBefore, "Worker migrations must not alter legacy matches schema or rows");
  const schemaAfterFirstApply = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
  applyMigrations();
  assert.deepEqual(db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
    WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY type,name`).all(), schemaAfterFirstApply,
    "Worker migrations must be idempotent");
  const d1 = new LocalD1(db);
  return { db, d1, layer: createWorkerBLayer({ DB: d1, core, identityApi, now: () => stamp }) };
}

function legacyArchiveSnapshot(db) {
  return {
    createSql: db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='matches'").get().sql,
    columns: JSON.stringify(db.prepare("PRAGMA table_info(matches)").all()),
    rowCount: db.prepare("SELECT COUNT(*) AS n FROM matches").get().n,
    sentinel: JSON.stringify(db.prepare("SELECT * FROM matches WHERE source='LEGACY' AND fixture_id='untouched'").get())
  };
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

test("Worker core keeps verified-history citations in prepared analysis payloads", () => {
  const makeIdentity = (teamId, providerTeamId, displayName) => ({ teamId, countryCode: "GB",
    names: [{ displayName, normalizedName: identityApi.normalizeTeamName(displayName), nameType: "current", verified: true }],
    providerIds: [{ provider: "ESPN", providerTeamId, verified: true }] });
  const identities = [makeIdentity("team:core-home", "home-id", "Synthetic Core Home"),
    makeIdentity("team:core-away", "away-id", "Synthetic Core Away")];
  const makeHistory = (teamId, opponentId) => Array.from({ length: 10 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 10, 15 - index)).toISOString().slice(0, 10);
    const isHome = teamId === "team:core-home";
    return { provider: "FAF", providerFixtureId: `composite:${teamId}:${index}`, kickoff: `${date}T15:00:00.000Z`,
      competitionId: "test-league", homeTeamId: isHome ? teamId : opponentId, awayTeamId: isHome ? opponentId : teamId,
      homeScore: 1, awayScore: 0, status: "completed", verified: true, statistics: [],
      verificationSource: "official provider page; synthetic test row" };
  });
  const prepared = workerCore.prepareDataCenter({ generatedAt: stamp, scopeComplete: true,
    expectedCompetitionIds: ["test"], loadedCompetitionIds: ["test"], identities,
    fixtures: [{ provider: "ESPN", providerFixtureId: "synthetic-core-fixture", competitionId: "test",
      kickoff: "2026-11-26T20:00:00.000Z", status: "scheduled",
      home: { provider: "ESPN", providerTeamId: "home-id" }, away: { provider: "ESPN", providerTeamId: "away-id" } }],
    historiesByTeam: { "team:core-home": makeHistory("team:core-home", "team:core-away"),
      "team:core-away": makeHistory("team:core-away", "team:core-home") } });
  const analysis = prepared.records.find(item => item.kind === "team_analysis" && item.payload.teamId === "team:core-home");
  assert.ok(analysis);
  assert.equal(analysis.payload.historyCount, 10);
  assert.ok(analysis.payload.history.every(item => item.verificationSource === "official provider page; synthetic test row"));
});

// Synthetic-only fixture set for adapter safety tests; it is not real-data acceptance.
function seedInterFafCase(db) {
  addIdentity(db, "team:inter", "Inter Club d'Escaldes", "Inter Club Escaldes", "20703");
  addIdentity(db, "team:inter-opponent", "Atlètic Club Escaldes", null, null);
  addIdentity(db, "team:wrong-side", "Wrong canonical side", null, null);
  db.prepare(`INSERT INTO mam_team_provider_ids
    (provider,provider_team_id,team_id,verified,source,valid_from,valid_to,verified_at,approved_by)
    VALUES('FAF','1770','team:inter',1,'official FAF fixture-test evidence','2000-01-01',NULL,?,'test-reviewer')`).run(stamp);
  seedTeamHistory(db, { id: "team:cph", slug: "cph", name: "F.C. København", alias: "FC Copenhagen", providerId: "909",
    opponentId: "team:cph-opponent", opponentName: "Synthetic Copenhagen Opponent" });

  const insert = db.prepare(`INSERT INTO mam_verified_history_matches
    (provider,provider_fixture_id,team_id,opponent_team_id,kickoff,competition_id,home_team_id,away_team_id,
     home_score,away_score,status,verified,source,verified_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'completed',1,?,?)`);
  const dates = ["2026-05-10", "2026-04-25", "2026-04-19", "2026-04-12", "2026-03-22",
    "2026-03-08", "2026-03-01", "2026-02-14", "2026-02-08", "2026-02-01"];
  dates.forEach((day, index) => {
    const homeId = index % 2 === 0 ? "team:inter" : "team:inter-opponent";
    const awayId = index % 2 === 0 ? "team:inter-opponent" : "team:inter";
    insert.run("FAF", `composite:672722:${day}:1770:1763`, "team:inter", "team:inter-opponent",
      `${day}T15:00:00.000Z`, "faf-league-672722", homeId, awayId, index % 3, (index + 1) % 3,
      "official FAF results page; synthetic test row", stamp);
  });
  // Wrong side assignment is structurally insertable, so the adapter must reject it.
  insert.run("FAF", "composite:bad-side", "team:inter", "team:inter-opponent", "2026-11-20T15:00:00.000Z",
    "faf-league-672722", "team:wrong-side", "team:inter", 1, 0, "synthetic bad-side row", stamp);
  // A valid post-cutoff row must not enter the pre-match history.
  insert.run("FAF", "composite:future", "team:inter", "team:inter-opponent", "2026-11-27T15:00:00.000Z",
    "faf-league-672722", "team:inter", "team:inter-opponent", 1, 0, "synthetic future row", stamp);
  insert.run("FAF", "composite:no-source", "team:inter", "team:inter-opponent", "2026-11-21T15:00:00.000Z",
    "faf-league-672722", "team:inter", "team:inter-opponent", 1, 0, "", stamp);
  // This legacy row duplicates a verified provider result exactly; core dedup must keep one event.
  addArchiveMatch(db, { source: "ESPN", fixtureId: "legacy-faf-duplicate", leagueId: "faf-league-672722",
    kickoff: "2026-05-10T15:00:00.000Z", homeId: "team:inter", awayId: "team:inter-opponent",
    homeName: "Inter Club d'Escaldes", awayName: "Atlètic Club Escaldes", homeScore: 0, awayScore: 1 });
  return { generatedAt: stamp, scopeComplete: true, expectedCompetitionIds: ["uefa"], loadedCompetitionIds: ["uefa"],
    fixtures: [{ provider: "ESPN", providerFixtureId: "inter-cph-2026", competitionId: "uefa",
      kickoff: "2026-11-26T20:00:00.000Z", status: "scheduled",
      home: { provider: "ESPN", providerTeamId: "20703", name: "Inter Club d'Escaldes" },
      away: { provider: "ESPN", providerTeamId: "909", name: "F.C. København" } }] };
}

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

test("verified FAF history is bounded, identity-consistent, deduplicated, and stats-empty", async () => {
  const { db, layer } = setup();
  try {
    const prepared = await layer.prepareByCompetition(seedInterFafCase(db));
    assert.equal(prepared.outcomes[0].readyFixtures, 1);
    const inter = prepared.records.find(item => item.kind === "team_analysis" && item.payload.teamId === "team:inter");
    assert.ok(inter);
    assert.equal(inter.payload.historyCount, 10);
    assert.equal(new Set(inter.payload.history.map(item => item.kickoff.slice(0, 10))).size, 10,
      "the exact-match legacy duplicate must not count twice");
    assert.ok(inter.payload.history.filter(item => item.archiveRef.startsWith("faf:")).length >= 9);
    assert.equal(inter.payload.history.some(item => item.archiveRef.includes("bad-side")), false);
    assert.equal(inter.payload.history.some(item => item.archiveRef.includes("future")), false);
    assert.equal(inter.payload.history.some(item => item.archiveRef.includes("no-source")), false);
    assert.ok(inter.payload.history.filter(item => item.archiveRef.startsWith("faf:"))
      .every(item => item.verificationSource === "official FAF results page; synthetic test row"),
      JSON.stringify(inter.payload.history.map(item => ({ ref: item.archiveRef, source: item.verificationSource }))));
    assert.equal(inter.payload.statisticsCoverage.matchesWithVerifiedStatistics, 0);
    assert.ok(inter.payload.history.every(item => item.statistics.length === 0), "missing FAF stats stay empty");
    assert.ok(inter.payload.verifiedProviderIds.some(item => item.provider === "FAF" && item.providerTeamId === "1770"));
    const copenhagen = prepared.records.find(item => item.kind === "team_analysis" && item.payload.teamId === "team:cph");
    assert.equal(copenhagen.payload.historyCount, 10);
  } finally { db.close(); }
});

test("conflicting legacy and verified-provider scores quarantine the fixture", async () => {
  const { db, layer } = setup();
  try {
    const request = seedInterFafCase(db);
    addArchiveMatch(db, { source: "ESPN", fixtureId: "legacy-faf-score-conflict", leagueId: "faf-league-672722",
      kickoff: "2026-05-10T15:00:00.000Z", homeId: "team:inter", awayId: "team:inter-opponent",
      homeName: "Inter Club d'Escaldes", awayName: "Atlètic Club Escaldes", homeScore: 4, awayScore: 0 });
    const prepared = await layer.prepareByCompetition(request);
    assert.equal(prepared.records.some(item => item.kind === "fixture"), false);
    assert.ok(prepared.quarantined.some(item => /history_conflict/.test(item.reason)));
  } finally { db.close(); }
});

// Synthetic double-capture rows for the additive statistics migration.
function seedStatisticsCase(db, { withStatistics = true } = {}) {
  addIdentity(db, "team:stats-home", "Statistics Home", null, "501");
  addIdentity(db, "team:stats-away", "Statistics Away", null, "502");
  const insert = db.prepare(`INSERT INTO mam_verified_history_matches
    (provider,provider_fixture_id,team_id,opponent_team_id,kickoff,competition_id,home_team_id,away_team_id,
     home_score,away_score,status,verified,source,verified_at)
    VALUES('ESPN',?,?,?,?,?,?,?,?,?,'completed',1,'ESPN event page; synthetic test row',?)`);
  const stats = withStatistics ? db.prepare(`INSERT INTO mam_verified_history_statistics
    (provider,provider_fixture_id,team_id,metric,value,unit,provider_metric,capture_hash_a,capture_hash_b,
     source_url,verified,verified_at)
    VALUES('ESPN',?,?,?,?,NULL,?,?,?,'https://sports.core.api.espn.com/.../statistics',1,?)`) : null;
  const hash = "c".repeat(64);
  for (let i = 0; i < 10; i++) {
    const kickoff = `2026-11-${String(20 - i).padStart(2, "0")}T15:00:00Z`;
    const fixtureId = `stats-${i}`;
    const homeId = i % 2 === 0 ? "team:stats-home" : "team:stats-away";
    const awayId = i % 2 === 0 ? "team:stats-away" : "team:stats-home";
    insert.run(fixtureId, "team:stats-home", "team:stats-away", kickoff, "test-league", homeId, awayId, 2, 1, stamp);
    insert.run(fixtureId, "team:stats-away", "team:stats-home", kickoff, "test-league", homeId, awayId, 2, 1, stamp);
    if (withStatistics) {
      stats.run(fixtureId, "team:stats-home", "corners", 4 + i, "wonCorners", hash, hash, stamp);
      stats.run(fixtureId, "team:stats-away", "corners", 3 + i, "wonCorners", hash, hash, stamp);
    }
  }
  return { generatedAt: stamp, scopeComplete: true, expectedCompetitionIds: ["test-league"],
    loadedCompetitionIds: ["test-league"],
    fixtures: [{ provider: "ESPN", providerFixtureId: "stats-next", competitionId: "test-league",
      kickoff: "2026-12-13T17:30:00Z", status: "scheduled",
      home: { provider: "ESPN", providerTeamId: "501", name: "Statistics Home" },
      away: { provider: "ESPN", providerTeamId: "502", name: "Statistics Away" } }] };
}

test("double-captured verified statistics reach the prepared payload and the app consumer", async () => {
  const { db, layer } = setup();
  try {
    const published = await layer.publish(seedStatisticsCase(db));
    assert.equal(published.readyFixtures, 1);
    const bundle = await layer.readFixtureBundle("espn:stats-next");
    assert.ok(bundle);
    for (const side of ["home", "away"]) {
      const payload = bundle.analyses[side].payload;
      assert.equal(payload.statisticsCoverage.matchesWithVerifiedStatistics, 10);
      assert.equal(payload.statisticsCoverage.verifiedMetricCounts.corners, 10);
      assert.ok(payload.history.every(item => item.statistics.length === 1 && item.statistics[0].verified === true),
        "verified statistics must keep their per-value marker in the payload");
    }
    const consumer = await loadPreparedAnalysis(async () => bundle, { provider: "espn", fixtureId: "stats-next",
      kickoff: "2026-12-13T17:30:00Z", homeTeamId: 501, awayTeamId: 502 });
    assert.ok(consumer, "the real app consumer must accept a bundle that carries verified statistics");
    const mapped = consumer.homeHistory[0].statistics[0].statistics;
    assert.equal(mapped.length, 1);
    assert.equal(mapped[0].type, "corners");
    assert.equal(typeof mapped[0].value, "number");
  } finally { db.close(); }
});

test("a target without the statistics migration still prepares with empty statistics", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(`CREATE TABLE matches (
      source TEXT NOT NULL, fixture_id TEXT NOT NULL, league_id TEXT NOT NULL, league_name TEXT,
      country TEXT, kickoff TEXT NOT NULL, status TEXT NOT NULL, home_team_id TEXT, home_team TEXT,
      away_team_id TEXT, away_team TEXT, home_goals INTEGER, away_goals INTEGER,
      statistics_json TEXT, raw_json TEXT, updated_at TEXT, PRIMARY KEY(source,fixture_id)
    );`);
    const directory = path.join(__dirname, "..", "migrations");
    for (const file of fs.readdirSync(directory).filter(name => /^\d+_.*\.sql$/.test(name) && !name.startsWith("0005")).sort())
      db.exec(fs.readFileSync(path.join(directory, file), "utf8"));
    const layer = createWorkerBLayer({ DB: new LocalD1(db), core, identityApi, now: () => stamp });
    const prepared = await layer.prepareByCompetition(seedStatisticsCase(db, { withStatistics: false }));
    assert.equal(prepared.records.filter(item => item.kind === "fixture").length, 1);
    const analysis = prepared.records.find(item => item.kind === "team_analysis");
    assert.equal(analysis.payload.statisticsCoverage.matchesWithVerifiedStatistics, 0);
  } finally { db.close(); }
});

// Synthetic rows for migration 0006: verified halftime columns.
function seedHalftimeCase(db) {
  addIdentity(db, "team:half-home", "Halftime Home", null, "601");
  addIdentity(db, "team:half-away", "Halftime Away", null, "602");
  const insert = db.prepare(`INSERT INTO mam_verified_history_matches
    (provider,provider_fixture_id,team_id,opponent_team_id,kickoff,competition_id,home_team_id,away_team_id,
     home_score,away_score,status,verified,source,verified_at)
    VALUES('ESPN',?,?,?,?,?,?,?,?,?,'completed',1,'ESPN event page; synthetic test row',?)`);
  const half = db.prepare(`INSERT INTO mam_verified_history_halftime
    (provider,provider_fixture_id,team_id,halftime_home,halftime_away,verified,source,verified_at)
    VALUES('ESPN',?,?,?,?,1,'ESPN linescore; synthetic test row',?)`);
  const add = (fixtureId, kickoff, homeScore, awayScore, halfHome, halfAway) => {
    insert.run(fixtureId, "team:half-home", "team:half-away", kickoff, "test-league",
      "team:half-home", "team:half-away", homeScore, awayScore, stamp);
    insert.run(fixtureId, "team:half-away", "team:half-home", kickoff, "test-league",
      "team:half-home", "team:half-away", homeScore, awayScore, stamp);
    half.run(fixtureId, "team:half-home", halfHome, halfAway, stamp);
    half.run(fixtureId, "team:half-away", halfHome, halfAway, stamp);
  };
  // One row whose halftime exceeds the full-time score must be rejected.
  add("half-overflow", "2026-11-25T15:00:00Z", 2, 1, 3, 0);
  for (let i = 0; i < 10; i++) {
    const kickoff = `2026-11-${String(20 - i).padStart(2, "0")}T15:00:00Z`;
    add(`half-${i}`, kickoff, 2, 1, 1, 0);
  }
  return { generatedAt: stamp, scopeComplete: true, expectedCompetitionIds: ["test-league"],
    loadedCompetitionIds: ["test-league"],
    fixtures: [{ provider: "ESPN", providerFixtureId: "half-next", competitionId: "test-league",
      kickoff: "2026-12-13T17:30:00Z", status: "scheduled",
      home: { provider: "ESPN", providerTeamId: "601", name: "Halftime Home" },
      away: { provider: "ESPN", providerTeamId: "602", name: "Halftime Away" } }] };
}

test("verified halftime columns reach the payload and stay bounded by the full-time score", async () => {
  const { db, layer } = setup();
  try {
    const published = await layer.publish(seedHalftimeCase(db));
    assert.equal(published.readyFixtures, 1);
    const bundle = await layer.readFixtureBundle("espn:half-next");
    assert.ok(bundle);
    for (const side of ["home", "away"]) {
      const history = bundle.analyses[side].payload.history;
      const withHalftime = history.filter(item => item.halftime);
      assert.equal(withHalftime.length, 9, "nine valid rows keep halftime, the overflow row must not");
      assert.ok(withHalftime.every(item => item.halftime.homeScore === 1 && item.halftime.awayScore === 0));
      const overflow = history.find(item => item.archiveRef.includes("half-overflow"));
      assert.equal(overflow.halftime, null);
    }
    const consumer = await loadPreparedAnalysis(async () => bundle, { provider: "espn", fixtureId: "half-next",
      kickoff: "2026-12-13T17:30:00Z", homeTeamId: 601, awayTeamId: 602 });
    assert.ok(consumer);
    const halves = consumer.homeHistory.filter(item => item.score?.halftime);
    assert.equal(halves.length, 9);
    assert.deepEqual(halves[0].score.halftime, { home: 1, away: 0 });
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

test("daily B preparation consumes verified staged fixtures without changing matches and prefers matching archive rows", async () => {
  const { db, layer } = setup();
  try {
    seedAll(db);
    const archiveBefore = legacyArchiveSnapshot(db);
    db.prepare(`INSERT INTO mam_b_fixture_staging(provider,provider_fixture_id,competition_id,kickoff,status,
      home_provider_team_id,home_team_name,home_country_code,away_provider_team_id,away_team_name,away_country_code,
      verified,verification_source,verified_at,approved_by)
      VALUES('ESPN','bournemouth-next','3','2026-11-27T15:00:00Z','scheduled',
        '349','Bournemouth','GB','301','Viktoria Plzeň','GB',1,'synthetic fixture source',?,'test-reviewer')`)
      .run(stamp);

    const stagedResult = await layer.prepareFromD1Upcoming();
    assert.equal(stagedResult.readyFixtures, 1);
    assert.equal(stagedResult.archiveFixtureCount, 0);
    assert.equal(stagedResult.stagedFixtureCount, 1);
    assert.ok(stagedResult.d1Metrics.rowsRead > 0);
    assert.ok(stagedResult.d1Metrics.rowsWritten > 0);
    const stagedBundle = await layer.readFixtureBundle("espn:bournemouth-next");
    assert.equal(stagedBundle.analyses.home.payload.historyCount, 10);
    assert.equal(stagedBundle.analyses.away.payload.historyCount, 10);
    assert.deepEqual(legacyArchiveSnapshot(db), archiveBefore, "staging-only preparation must not write to matches");

    db.prepare(`INSERT INTO matches(source,fixture_id,league_id,league_name,country,kickoff,status,home_team_id,home_team,
      away_team_id,away_team,raw_json,updated_at) VALUES('ESPN','bournemouth-next','archive-league','Archive League','England',
      '2026-11-28T15:00:00Z','NS','349','Bournemouth','301','Viktoria Plzeň',?,?)`)
      .run(JSON.stringify({ teams: { home: { id: "349", name: "Bournemouth" },
        away: { id: "301", name: "Viktoria Plzeň" } } }), "2026-11-26T21:03:00.000Z");
    const preferredArchive = await layer.prepareFromD1Upcoming();
    assert.equal(preferredArchive.archiveFixtureCount, 1);
    assert.equal(preferredArchive.stagedFixtureCount, 1);
    const archivePreferredBundle = await layer.readFixtureBundle("espn:bournemouth-next");
    assert.match(archivePreferredBundle.fixture.kickoff, /^2026-11-28/);
    assert.equal(legacyArchiveSnapshot(db).rowCount, archiveBefore.rowCount + 1,
      "only the explicit test insertion changes matches; B preparation must not write there");
    assert.equal((await layer.prepareFromD1Upcoming()).noOp, true);
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
