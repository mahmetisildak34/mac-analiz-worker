import assert from "node:assert/strict";
import test from "node:test";
import {backtestCutoff, evaluateArchive} from "../scripts/poisson-archive-backtest.mjs";

const match = {
  source: "provider", identity_verified: true, score_verified: true,
  fixture: {id: "fixture-1", date: "2025-11-01T20:30:00Z", status: {short: "FT"}},
  league: {id: "test"}, teams: {home: {name: "Home"}, away: {name: "Away"}},
  goals: {home: 2, away: 1}
};

test("backtest cutoff excludes the match day and the previous day", () => {
  assert.equal(backtestCutoff(match.fixture.date), "2025-10-31T00:00:00.000Z");
});

test("backtest drops duplicates, missing league and unverified outcomes", () => {
  const result = evaluateArchive([
    match, {...match, goals: {home: 3, away: 1}},
    {...match, league: null},
    {...match, league: {id: "unverified"}, score_verified: false},
    {...match, league: {id: "valid"}}
  ], 5);
  assert.deepEqual(Object.keys(result), ["valid"]);
  assert.equal(result.valid.verified_matches, 1);
  assert.equal(result.valid.models["1.2"].full_time.samples, 0);
  assert.equal(result.valid.models["1.3"].half_time.log_loss, null);
});
