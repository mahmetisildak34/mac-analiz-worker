import assert from "node:assert/strict";
import test from "node:test";
import { evaluateMarkets } from "../scripts/poisson-market-metrics.mjs";

test("score marginals, double chance, BTTS and totals use the same outcomes", () => {
  // 1–0 with probability 3/4, 2–2 with probability 1/4.
  const values = [0, 0, 0, 0.75, 0, 0, 0, 0, 0.25];
  const target = { home_goals: 1, away_goals: 0 };
  const markets = evaluateMarkets([{ prediction: { values }, target }], 2);
  assert.equal(markets.result.log_loss, -Math.log(0.75));
  assert.equal(markets.home_or_draw.brier, 0);
  assert.equal(markets.away_or_draw.brier, 0.125);
  assert.equal(markets.home_or_away.brier, 0.125);
  assert.equal(markets.btts.brier, 0.125);
  assert.equal(markets["over_0.5"].brier, 0);
  assert.equal(markets["over_4.5"].brier, 0);
  assert.equal(markets.home_goals.expected_goal_mean, 1.25);
  assert.equal(markets.away_goals.expected_goal_mean, 0.5);
  assert.equal(markets.score.n, 1);
});

test("empty model comparisons have no metrics", () => {
  assert.deepEqual(evaluateMarkets([], 2).result, { n: 0, brier: null, log_loss: null, ece: null });
});
