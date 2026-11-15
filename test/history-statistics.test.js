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
  HISTORY_STATISTICS_KEY
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
          first: async () => ({ total: 123 })
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
  assert.equal(result.executionEnabled, false);
  assert.equal(result.scope, "all-configured-competitions-statistics");
  assert.equal(storedKey, HISTORY_STATISTICS_KEY);
  assert.equal(storedState.status, "queued");
});

test("general statistics processor remains disabled without explicit Preview/worker flag", async () => {
  const result = await runHistoryStatisticsBatch({});
  assert.equal(result.status, "disabled");
});
