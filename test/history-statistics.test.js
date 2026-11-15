import test from "node:test";
import assert from "node:assert/strict";
import {
  CLUB_COMPETITIONS,
  NATIONAL_TEAM_COMPETITIONS,
  NATIONAL_TEAM_COMPETITION_IDS,
  classifyHistoryCompetition,
  getHistoryCompetitionCatalog,
  buildHistoryStatisticsState,
  runHistoryStatisticsBatch,
  HISTORY_STATISTICS_KEY,
  CLUB_HISTORY_BACKFILL_KEY,
  NATIONAL_TEAM_HISTORY_BACKFILL_KEY,
  buildHistoryBackfillScopedState,
  getHistoryBackfillQueueConfig
} from "../history-statistics.js";

test("all configured competitions are classified exactly once as club or national team", () => {
  const catalog = getHistoryCompetitionCatalog();
  assert.equal(catalog.total, 39);
  assert.equal(catalog.nationalTeams.length, 5);
  assert.equal(catalog.clubs.length, 34);
  assert.equal(NATIONAL_TEAM_COMPETITIONS.length + CLUB_COMPETITIONS.length, 39);
  assert.deepEqual(NATIONAL_TEAM_COMPETITIONS.map(item => item[0]), NATIONAL_TEAM_COMPETITION_IDS);
  assert.equal(classifyHistoryCompetition("5"), "national-team");
  assert.equal(classifyHistoryCompetition("15"), "club");
  assert.equal(classifyHistoryCompetition("203"), "club");
});

test("catalog exposes named competitions and ESPN slugs for both categories", () => {
  const catalog = getHistoryCompetitionCatalog();
  assert.ok(catalog.nationalTeams.some(item => item.name === "UEFA Nations League" && item.slug === "uefa.nations"));
  assert.ok(catalog.nationalTeams.some(item => item.name === "FIFA World Cup" && item.slug === "fifa.world"));
  assert.ok(catalog.clubs.some(item => item.name === "FIFA Club World Cup" && item.slug === "fifa.cwc"));
  assert.deepEqual(catalog.nationalTeams.map(item => item.rank), [1, 2, 3, 4, 5]);
  assert.deepEqual(catalog.clubs.slice(0, 9).map(item => item.priority), Array(9).fill("high"));
  assert.equal(catalog.clubs[9].priority, "standard");
});

test("general statistics queue initializes disabled from completed staged fixtures only", async () => {
  let storedKey = "";
  let storedState;
  const env = {
    DB: {
      prepare(sql) {
        return {
          sql,
          run: async () => ({ meta: { changes: 1 } }),
          all: async () => ({ results: [{ name: "statistics_json" }] }),
          first: async () => sql.includes("mam_history_backfill_statistics")
            ? ({ processed: 5, statisticsFound: 4, noStatistics: 1 })
            : ({ total: 123 })
        };
      }
    },
    MAM_KV: {
      put: async (key, value) => { storedKey = key; storedState = JSON.parse(value); }
    }
  };
  const result = await buildHistoryStatisticsState(env, new Date("2026-11-15T00:00:00Z"));
  assert.equal(result.ok, true);
  assert.equal(result.totalJobs, 123);
  assert.equal(result.processedJobs, 5);
  assert.equal(result.statisticsFound, 4);
  assert.equal(result.noStatistics, 1);
  assert.equal(result.executionEnabled, false);
  assert.equal(result.scope, "all-configured-competitions-statistics");
  assert.equal(storedKey, HISTORY_STATISTICS_KEY);
  assert.equal(storedState.status, "queued");
});

test("general statistics processor remains disabled without explicit Preview/worker flag", async () => {
  const result = await runHistoryStatisticsBatch({});
  assert.equal(result.status, "disabled");
});

test("general statistics worker enriches a staged fixture using its matching ESPN competition", async () => {
  const batchStatements = [];
  let storedState = {
    scope: "all-configured-competitions-statistics",
    executionEnabled: true,
    totalJobs: 1,
    retryJobs: [],
    deadLetters: [],
    statisticsFound: 0,
    noStatistics: 0
  };
  const env = {
    HISTORY_STATISTICS_ENABLED: "true",
    MAM_KV: {
      get: async key => { assert.equal(key, HISTORY_STATISTICS_KEY); return storedState; },
      put: async (_key, value) => { storedState = JSON.parse(value); }
    },
    DB: {
      prepare(sql) {
        return {
          sql,
          values: [],
          bind(...values) { this.values = values; return this; },
          run: async () => ({ meta: { changes: sql.includes("SET owner = ?") || sql.includes("SET owner = ''") ? 1 : 0 } }),
          all: async () => {
            if (sql.includes("PRAGMA table_info")) return { results: [{ name: "statistics_json" }] };
            if (sql.includes("SELECT m.fixture_id")) return { results: [{
              fixtureId: "espn-eng.1-999", leagueId: "39", kickoff: "2026-11-01T16:30:00Z", status: "FT"
            }] };
            return { results: [] };
          },
          first: async () => ({ total: 1 })
        };
      },
      batch: async statements => {
        batchStatements.push(...statements);
        return statements.map(() => ({ meta: { changes: 1 } }));
      }
    }
  };
  let requestedUrl = "";
  const result = await runHistoryStatisticsBatch(env, async url => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ boxscore: { teams: [
      { homeAway: "home", team: { displayName: "Liverpool" }, statistics: [{ name: "shots", displayValue: "12" }] },
      { homeAway: "away", team: { displayName: "Arsenal" }, statistics: [{ name: "shots", displayValue: "9" }] }
    ] } }), { status: 200 });
  });
  assert.equal(result.ok, true);
  assert.equal(result.statisticsFound, 1);
  assert.equal(result.status, "complete");
  assert.match(requestedUrl, /soccer\/eng\.1\/summary\?event=999/);
  assert.equal(batchStatements.length, 2);
  assert.match(batchStatements[0].sql, /INSERT INTO mam_history_backfill_statistics/);
  assert.equal(batchStatements[0].values[0], "espn-eng.1-999");
  assert.equal(batchStatements[0].values[1], "39");
  assert.match(batchStatements[1].sql, /UPDATE mam_history_backfill_matches SET statistics_json/);
  assert.equal(storedState.statisticsFound, 1);
});

test("club and national-team fixture queues are separate, ordered, and disabled initially", () => {
  const clubs = buildHistoryBackfillScopedState("clubs", new Date("2026-11-15T00:00:00Z"));
  const national = buildHistoryBackfillScopedState("national-teams", new Date("2026-11-15T00:00:00Z"));
  assert.equal(clubs.scope, "club-competitions");
  assert.equal(national.scope, "national-team-competitions");
  assert.equal(clubs.leagueCount, 34);
  assert.equal(national.leagueCount, 5);
  assert.equal(clubs.executionEnabled, false);
  assert.equal(national.executionEnabled, false);
  assert.equal(getHistoryBackfillQueueConfig("clubs").key, CLUB_HISTORY_BACKFILL_KEY);
  assert.equal(getHistoryBackfillQueueConfig("national-teams").key, NATIONAL_TEAM_HISTORY_BACKFILL_KEY);
  assert.equal(getHistoryBackfillQueueConfig("unknown"), null);
});

function makeStatisticsTestEnv(initialState, fixtureRows = []) {
  let state = structuredClone(initialState);
  const writtenBatches = [];
  const env = {
    HISTORY_STATISTICS_ENABLED: "true",
    MAM_KV: {
      get: async key => { assert.equal(key, HISTORY_STATISTICS_KEY); return state; },
      put: async (_key, value) => { state = JSON.parse(value); }
    },
    DB: {
      prepare(sql) {
        return {
          sql,
          values: [],
          bind(...values) { this.values = values; return this; },
          run: async () => ({ meta: { changes: /SET owner = \?|SET owner = ''/.test(sql) ? 1 : 0 } }),
          all: async () => {
            if (sql.includes("PRAGMA table_info")) return { results: [{ name: "statistics_json" }] };
            if (sql.includes("SELECT m.fixture_id")) return { results: fixtureRows };
            return { results: [] };
          },
          first: async () => {
            if (sql.includes("mam_history_backfill_statistics")) return { total: 0 };
            return { total: 1 };
          }
        };
      },
      batch: async statements => {
        writtenBatches.push(...statements);
        return statements.map(() => ({ meta: { changes: 1 } }));
      }
    }
  };
  return { env, getState: () => state, writtenBatches };
}

test("general statistics processor retries transient upstream failures with backoff", async () => {
  const fixture = { fixtureId: "espn-eng.1-999", leagueId: "39", kickoff: "2026-11-01T16:30:00Z" };
  const { env, getState } = makeStatisticsTestEnv({
    executionEnabled: true, retryJobs: [], deadLetters: [], statisticsFound: 0, noStatistics: 0
  }, [fixture]);
  const result = await runHistoryStatisticsBatch(env, async () => new Response("temporary", { status: 503 }));
  assert.equal(result.ok, true);
  assert.equal(result.status, "retry-needed");
  assert.equal(result.pendingRetries, 1);
  assert.equal(result.failures.length, 1);
  assert.equal(getState().retryJobs[0].attempts, 1);
  assert.ok(getState().retryJobs[0].retryAfter > Date.now());
});

test("general statistics processor records a valid empty box score as unavailable, not zero stats", async () => {
  const fixture = { fixtureId: "espn-eng.1-999", leagueId: "39", kickoff: "2026-11-01T16:30:00Z" };
  const { env, getState, writtenBatches } = makeStatisticsTestEnv({
    executionEnabled: true, retryJobs: [], deadLetters: [], statisticsFound: 0, noStatistics: 0
  }, [fixture]);
  const result = await runHistoryStatisticsBatch(env, async () => new Response(JSON.stringify({
    boxscore: { teams: [
      { homeAway: "home", team: { displayName: "Liverpool" }, statistics: [] },
      { homeAway: "away", team: { displayName: "Arsenal" }, statistics: [] }
    ] }
  }), { status: 200 }));
  assert.equal(result.ok, true);
  assert.equal(result.noStatistics, 1);
  assert.equal(getState().noStatistics, 1);
  assert.equal(writtenBatches.length, 2);
  assert.ok(writtenBatches[0].values.includes("no-statistics"));
});

test("general statistics processor moves the fifth failed attempt to dead letters", async () => {
  const fixtureId = "espn-eng.1-999";
  const { env, getState } = makeStatisticsTestEnv({
    executionEnabled: true,
    retryJobs: [{ fixtureId, leagueId: "39", kickoff: "2026-11-01T16:30:00Z", attempts: 4, retryAfter: 0 }],
    deadLetters: [], statisticsFound: 0, noStatistics: 0
  });
  const result = await runHistoryStatisticsBatch(env, async () => new Response("persistent failure", { status: 500 }));
  assert.equal(result.ok, true);
  assert.equal(result.status, "needs-review");
  assert.equal(result.pendingRetries, 0);
  assert.equal(result.deadLetters, 1);
  assert.equal(getState().deadLetters[0].attempts, 5);
});
