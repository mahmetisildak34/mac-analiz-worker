import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHistoryBackfillState,
  getHistoryBackfillBatch,
  runHistoryBackfillBatch,
  probeHistoryBackfillRange,
  runHistoryBackfillPilot,
  HISTORY_BACKFILL_LEAGUES
} from "../history-backfill.js";

test("history queue is compact metadata for 38 configured competitions", () => {
  const state = buildHistoryBackfillState(new Date("2026-11-14T12:00:00.000Z"));
  assert.equal(state.leagueCount, 38);
  assert.equal(state.dayCount, 867);
  assert.equal(state.totalJobs, 38 * 867);
  assert.equal(Array.isArray(state.jobs), false);
  assert.equal(state.executionEnabled, false);
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


test("empty ESPN 200 responses do not advance the historical cursor", async () => {
  let storedState = {
    rangeStart: "2024-07-01", dayCount: 1, totalJobs: 3, cursor: 0,
    executionEnabled: true, status: "queued"
  };
  const env = {
    HISTORY_BACKFILL_ENABLED: "true",
    MAM_KV: {
      get: async () => storedState,
      put: async (_key, value) => { storedState = JSON.parse(value); }
    },
    DB: {
      prepare() {
        return {
          bind() { return this; },
          run: async () => ({ meta: { changes: 1 } })
        };
      },
      batch: async statements => statements.map(() => ({ meta: { changes: 1 } }))
    }
  };
  const result = await runHistoryBackfillBatch(env, async () =>
    new Response(JSON.stringify({ events: [] }), { status: 200 })
  );
  assert.equal(result.advanced, 0);
  assert.equal(result.processedJobs, 0);
  assert.equal(result.failures.length, 3);
  assert.equal(storedState.cursor, 0);
  assert.equal(storedState.status, "retry-needed");
});
