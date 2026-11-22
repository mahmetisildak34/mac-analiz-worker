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

test("evaluates goal markets separately and labels predictions from limited team samples", () => {
  const rows = Array.from({length: 36}, (_, index) => ({
    ...match,
    fixture: {...match.fixture, id: String(index), date: new Date(Date.UTC(2025, 7, index + 1)).toISOString()},
    teams: index % 2
      ? {home: {name: "Home"}, away: {name: "Away Opponent " + index}}
      : {home: {name: "Home Opponent " + index}, away: {name: "Away"}},
    score: {halftime: {home: 1, away: 1}}
  }));
  const result = evaluateArchive([...rows, match], 5).test;
  for (const model of Object.values(result.models)) {
    assert.equal(model.full_time.samples, 1);
    assert.equal(model.full_time.limited_sample_matches, 1);
    assert.ok(Number.isFinite(model.full_time.binary_markets.btts_yes.log_loss));
    assert.ok(Number.isFinite(model.full_time.binary_markets.over_2_5.brier));
    assert.equal(model.half_time.samples, 0);
  }
});
