import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHistoryBackfillState,
  getHistoryBackfillBatch,
  runHistoryBackfillBatch,
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
