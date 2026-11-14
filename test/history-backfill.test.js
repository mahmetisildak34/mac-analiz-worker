import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHistoryBackfillState,
  getHistoryBackfillBatch,
  runHistoryBackfillBatch,
  probeHistoryBackfillRange,
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
