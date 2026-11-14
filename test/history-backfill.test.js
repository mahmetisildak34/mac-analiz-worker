import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHistoryBackfillState,
  buildNationsLeagueBackfillState,
  NATIONS_LEAGUE_BACKFILL_LEAGUE,
  buildNationsLeagueStatisticsState,
  runNationsLeagueStatisticsBatch,
  NATIONS_LEAGUE_STATISTICS_KEY,
  getHistoryBackfillBatch,
  runHistoryBackfillBatch,
  probeHistoryBackfillRange,
  probeHistoryBackfillBatch,
  runHistoryBackfillPilot,
  HISTORY_BACKFILL_LEAGUES
} from "../history-backfill.js";

test("history queue is compact metadata for 39 configured competitions", () => {
  const state = buildHistoryBackfillState(new Date("2026-11-14T12:00:00.000Z"));
  assert.equal(state.leagueCount, 39);
  assert.equal(state.dayCount, 867);
  assert.equal(state.totalJobs, 39 * 867);
  assert.equal(Array.isArray(state.jobs), false);
  assert.equal(state.executionEnabled, false);
});

test("popular leagues are processed before the remaining archive competitions", () => {
  assert.deepEqual(
    HISTORY_BACKFILL_LEAGUES.slice(0, 9).map(league => league[0]),
    ["203", "39", "140", "78", "135", "61", "2", "3", "848"]
  );
});

test("batch generation is bounded and deterministic", () => {
  const state = buildHistoryBackfillState(new Date("2026-11-14T12:00:00.000Z"));
  const batch = getHistoryBackfillBatch(state, 500);
  assert.equal(batch.length, 50);
  assert.deepEqual(batch[0].league, HISTORY_BACKFILL_LEAGUES[0]);
  assert.equal(batch[0].date, "20240701");
  assert.equal(batch[49].date, "20240819");
});

test("cursor maps to next competition without skipping dates", () => {
  const state = buildHistoryBackfillState(new Date("2026-11-14T12:00:00.000Z"));
  state.cursor = state.dayCount - 1;
  const batch = getHistoryBackfillBatch(state, 2);
  assert.equal(batch.length, 2);
  assert.equal(batch[0].date, "20261114");
  assert.deepEqual(batch[1].league, HISTORY_BACKFILL_LEAGUES[1]);
  assert.equal(batch[1].date, "20240701");
});

test("invalid or completed cursors return no work", () => {
  const state = buildHistoryBackfillState(new Date("2026-11-14T12:00:00.000Z"));
  assert.deepEqual(getHistoryBackfillBatch({ ...state, dayCount: 0 }, 5), []);
  assert.deepEqual(getHistoryBackfillBatch({ ...state, cursor: state.totalJobs }, 5), []);
});

test("processor remains disabled unless environment feature flag is set", async () => {
  const result = await runHistoryBackfillBatch({});
  assert.equal(result.status, "disabled");
});

test("processor refuses to run before queue is explicitly enabled", async () => {
  const env = {
    HISTORY_BACKFILL_ENABLED: "true",
    MAM_KV: { get: async () => ({ totalJobs: 10, cursor: 0, executionEnabled: false }) },
    DB: {}
  };
  const result = await runHistoryBackfillBatch(env);
  assert.equal(result.status, "not-enabled");
});

test("ESPN range probe validates input and never writes archive data", async () => {
  let requestedUrl = "";
  const fetchMock = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ events: [{ id: "123", date: "2026-11-01T15:00:00Z", name: "Test match" }] }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  };
  const result = await probeHistoryBackfillRange({
    leagueSlug: "eng.1", dateFrom: "20261101", dateTo: "20261107"
  }, fetchMock);
  assert.equal(result.ok, true);
  assert.equal(result.eventCount, 1);
  assert.match(requestedUrl, /dates=20261101-20261107/);
  let singleDayUrl = "";
  const singleDay = await probeHistoryBackfillRange({
    leagueSlug: "eng.1", dateFrom: "20261101", dateTo: "20261101"
  }, async url => {
    singleDayUrl = String(url);
    return new Response(JSON.stringify({ events: [] }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  });
  assert.equal(singleDay.ok, true);
  assert.match(singleDayUrl, /dates=20261101&/);
  assert.doesNotMatch(singleDayUrl, /dates=20261101-/);
  assert.equal((await probeHistoryBackfillRange({
    leagueSlug: "unknown", dateFrom: "20261101", dateTo: "20261107"
  }, fetchMock)).status, "invalid-input");
  assert.equal((await probeHistoryBackfillRange({
    leagueSlug: "eng.1", dateFrom: "20261101", dateTo: "20261110"
  }, fetchMock)).status, "invalid-range");
});

test("ESPN range probe reports upstream denial without treating it as empty coverage", async () => {
  const result = await probeHistoryBackfillRange({
    leagueSlug: "eng.1", dateFrom: "20261101", dateTo: "20261107"
  }, async () => new Response("Access Denied", { status: 403 }));
  assert.equal(result.ok, false);
  assert.equal(result.status, "upstream-http-error");
  assert.equal(result.httpStatus, 403);
});


test("pilot refuses to write when any league returns empty events", async () => {
  let dbWrites = 0;
  const env = {
    HISTORY_BACKFILL_PILOT_ENABLED: "true",
    DB: {
      prepare() {
        return { run: async () => { dbWrites++; }, bind() { return this; } };
      },
      batch: async () => { dbWrites++; return []; }
    }
  };
  const result = await runHistoryBackfillPilot(env, async url => {
    const slug = new URL(url).pathname.split("/").at(-2);
    const validEvent = {
      id: "1", date: "2026-11-01T12:00:00Z",
      competitions: [{ competitors: [
        { homeAway: "home", team: { displayName: "Home FC" } },
        { homeAway: "away", team: { displayName: "Away FC" } }
      ] }]
    };
    return new Response(JSON.stringify({ events: slug === "ger.1" ? [] : [validEvent] }), { status: 200 });
  });
  assert.equal(result.status, "empty-or-invalid-upstream");
  assert.equal(result.saved, 0);
  assert.equal(dbWrites, 0);
});

test("pilot stages validated matches from all three leagues in one idempotent batch", async () => {
  let createCalls = 0;
  let batchRows = [];
  const env = {
    HISTORY_BACKFILL_PILOT_ENABLED: "true",
    DB: {
      prepare(sql) {
        return {
          sql,
          run: async () => { createCalls++; },
          bind(...values) { this.values = values; return this; }
        };
      },
      batch: async statements => {
        batchRows = statements;
        return statements.map(() => ({ meta: { changes: 1 } }));
      }
    }
  };
  const makeEvent = (id, date) => ({
    id: String(id), date,
    competitions: [{
      competitors: [
        { homeAway: "home", team: { id: "10", displayName: "Home FC" }, score: "2" },
        { homeAway: "away", team: { id: "20", displayName: "Away FC" }, score: "1" }
      ]
    }],
    status: { type: { state: "post", completed: true } }
  });
  const counts = { "eng.1": 1, "esp.1": 4, "ger.1": 2, "tur.1": 4 };
  const result = await runHistoryBackfillPilot(env, async url => {
    const slug = new URL(url).pathname.split("/").at(-2);
    return new Response(JSON.stringify({
      events: Array.from({ length: counts[slug] }, (_, index) => makeEvent(index + 1, "2026-11-01T12:00:00Z"))
    }), { status: 200 });
  });
  assert.equal(result.ok, true);
  assert.equal(result.fetchedMatches, 11);
  assert.equal(result.databaseChanges, 11);
  assert.equal(batchRows.length, 11);
  assert.equal(createCalls, 1);
  assert.equal(result.status, "pilot-staged");
});

test("pilot stays disabled unless its dedicated Preview flag is enabled", async () => {
  const result = await runHistoryBackfillPilot({});
  assert.equal(result.status, "pilot-disabled");
});


test("empty ESPN 200 responses are completed days and advance the cursor", async () => {
  let storedState = {
    rangeStart: "2024-07-01", dayCount: 1, totalJobs: 3, cursor: 0,
    executionEnabled: true, status: "queued", retryJobs: [], deadLetters: []
  };
  const env = {
    HISTORY_BACKFILL_ENABLED: "true",
    MAM_KV: {
      get: async () => storedState,
      put: async (_key, value) => { storedState = JSON.parse(value); }
    },
    DB: {
      prepare() {
        return { bind() { return this; }, run: async () => ({ meta: { changes: 1 } }) };
      },
      batch: async statements => statements.map(() => ({ meta: { changes: 1 } }))
    }
  };
  let requests = 0;
  const result = await runHistoryBackfillBatch(env, async () => {
    requests++;
    return new Response(JSON.stringify({ events: [] }), { status: 200 });
  });
  assert.equal(requests, 3, JSON.stringify(result));
  assert.equal(result.status, "complete");
  assert.equal(result.advanced, 3);
  assert.equal(result.successfulDays, 3);
  assert.equal(result.emptyDays, 3);
  assert.equal(result.failures.length, 0);
  assert.equal(result.pendingRetries, 0);
  assert.equal(storedState.cursor, 3);
});

test("upstream failures advance discovery and enter a delayed retry queue", async () => {
  let storedState = {
    rangeStart: "2024-07-01", dayCount: 1, totalJobs: 2, cursor: 0,
    executionEnabled: true, status: "queued", retryJobs: [], deadLetters: []
  };
  const env = {
    HISTORY_BACKFILL_ENABLED: "true",
    MAM_KV: {
      get: async () => storedState,
      put: async (_key, value) => { storedState = JSON.parse(value); }
    },
    DB: {
      prepare() {
        return { bind() { return this; }, run: async () => ({ meta: { changes: 1 } }) };
      },
      batch: async statements => statements.map(() => ({ meta: { changes: 1 } }))
    }
  };
  const result = await runHistoryBackfillBatch(env, async () =>
    new Response("temporary failure", { status: 503 })
  );
  assert.equal(result.advanced, 2);
  assert.equal(result.pendingRetries, 2);
  assert.equal(result.failures.length, 2);
  assert.equal(storedState.cursor, 2);
  assert.equal(storedState.retryJobs.length, 2);
  assert.ok(storedState.retryJobs.every(job => job.attempts === 1 && job.retryAfter > Date.now()));
});


test("read-only coverage batches check at most five configured leagues and never write", async () => {
  const requested = [];
  const result = await probeHistoryBackfillBatch({
    offset: 0, limit: 5, date: "20261101"
  }, async url => {
    requested.push(String(url));
    return new Response(JSON.stringify({ events: [] }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "coverage-batch-complete");
  assert.equal(result.totalLeagues, 39);
  assert.equal(result.requested, 5);
  assert.equal(result.successCount, 5);
  assert.equal(requested.length, 5);
  assert.ok(requested.every(url => url.includes("dates=20261101&")));
  const invalid = await probeHistoryBackfillBatch({ offset: 0, limit: 6, date: "20261101" });
  assert.equal(invalid.status, "invalid-input");
});

test("Copa América uses ESPN's configured CONMEBOL slug", async () => {
  const league = HISTORY_BACKFILL_LEAGUES.find(item => item[0] === "9");
  assert.ok(league);
  assert.equal(league[1], "conmebol.copa_america");
  let requestedUrl = "";
  const result = await probeHistoryBackfillRange({
    leagueSlug: league[1], dateFrom: "20240714", dateTo: "20240714"
  }, async url => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ events: [] }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  });
  assert.equal(result.ok, true);
  assert.equal(result.league, "Copa América");
  assert.match(requestedUrl, /\/soccer\/conmebol\.copa_america\/scoreboard\?/);
});

test("UEFA Nations League queue covers the 2024 and 2026 editions only, isolated from the general archive", () => {
  const state = buildNationsLeagueBackfillState(new Date("2026-11-14T12:00:00.000Z"));
  assert.equal(state.scope, "uefa-nations-league");
  assert.equal(state.rangeStart, "2024-09-05");
  assert.equal(state.rangeEnd, "2026-11-14");
  assert.deepEqual(state.seasonsRequested, ["2024/25", "2026/27"]);
  assert.equal(state.leagueCount, 1);
  assert.equal(state.totalJobs, state.dayCount);
  assert.equal(state.executionEnabled, false);
  assert.deepEqual(NATIONS_LEAGUE_BACKFILL_LEAGUE, ["5", "uefa.nations", "UEFA Nations League", "Europe"]);
  const batch = getHistoryBackfillBatch(state, 3, [NATIONS_LEAGUE_BACKFILL_LEAGUE]);
  assert.equal(batch.length, 3);
  assert.ok(batch.every(job => job.league[1] === "uefa.nations"));
  assert.deepEqual(batch.map(job => job.date), ["20240905", "20240906", "20240907"]);
});

test("Nations League statistics queue initializes from completed staged fixtures only", async () => {
  let stored = null;
  const env = {
    DB: { prepare: () => ({ first: async () => ({ total: 12 }) }) },
    MAM_KV: { put: async (key, value) => { assert.equal(key, NATIONS_LEAGUE_STATISTICS_KEY); stored = JSON.parse(value); } }
  };
  const result = await buildNationsLeagueStatisticsState(env, new Date("2026-11-14T12:00:00Z"));
  assert.equal(result.ok, true);
  assert.equal(result.totalJobs, 12);
  assert.equal(result.executionEnabled, false);
  assert.equal(stored.scope, "uefa-nations-league-statistics");
});

test("Nations League statistics processor stays disabled unless explicitly enabled", async () => {
  const result = await runNationsLeagueStatisticsBatch({});
  assert.equal(result.status, "disabled");
});

test("Nations League statistics processor stores raw summary and parsed team stats in isolated table", async () => {
  const saved = [];
  const env = {
    HISTORY_STATISTICS_ENABLED: "true",
    MAM_KV: { get: async () => ({
      totalJobs: 1, cursor: 0, executionEnabled: true, retryJobs: [],
      statisticsFound: 0, noStatistics: 0
    }), put: async (_key, value) => { env.nextState = JSON.parse(value); } },
    DB: {
      prepare(sql) {
        return {
          bind(...values) { this.values = values; return this; },
          all: async () => ({ results: [{ fixtureId: "espn-uefa.nations-12345", kickoff: "2024-09-05T18:45:00Z", status: "FT" }] }),
          run: async () => ({ meta: { changes: sql.includes("UPDATE mam_history_backfill_statistics_lock") ? 1 : 0 } }),
          sql
        };
      },
      batch: async statements => { saved.push(...statements); return statements.map(() => ({ meta: { changes: 1 } })); }
    }
  };
  const result = await runNationsLeagueStatisticsBatch(env, async url => {
    assert.match(String(url), /uefa\.nations\/summary\?event=12345/);
    return new Response(JSON.stringify({ boxscore: { teams: [
      { homeAway: "home", team: { displayName: "Home" }, statistics: [{ name: "shots", displayValue: "12" }] },
      { homeAway: "away", team: { displayName: "Away" }, statistics: [{ name: "shots", displayValue: "8" }] }
    ] } }), { status: 200 });
  });
  assert.equal(result.statisticsFound, 1);
  assert.equal(result.noStatistics, 0);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].values[0], "espn-uefa.nations-12345");
  assert.equal(saved[0].values[2], "statistics-found");
  assert.equal(env.nextState.cursor, 1);
});
