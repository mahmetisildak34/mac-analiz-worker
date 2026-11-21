import assert from "node:assert/strict";
import test from "node:test";
import { predictTrustedGoals, predictTrustedHalfTime } from "../trusted-goal-poisson.js";
import { selectOnValidation } from "../scripts/poisson-validation-selection.mjs";

test("model selection refuses any test-period result and retains baseline on a tie", () => {
  const row = { target: { kickoff: "2025-06-30" }, map: { current: 1, candidate: 1 } };
  const score = rows => rows[0].prediction;
  const args = [["current", "candidate"], "current", "2025-07-01", score];
  assert.equal(selectOnValidation([row], ...args).model, "current");
  assert.equal(selectOnValidation([{ ...row, map: { current: 1, candidate: 0.9 } }], ...args).model, "candidate");
  assert.throws(() => selectOnValidation([row, { ...row, target: { kickoff: "2025-07-01" } }], ...args), /post-validation/);
});

test("conflicting scores cannot produce a prediction in either period", () => {
  const base = {
    source: "ESPN", home_team: "Home", away_team: "Opponent", kickoff: "2026-11-01T10:00:00Z",
    identity_verified: true, score_verified: true, completed: true, home_goals: 1, away_goals: 0,
    halftime_score_verified: true, halftime_home_goals: 1, halftime_away_goals: 0,
  };
  const home = Array.from({ length: 5 }, (_, i) => ({ ...base, fixture_id: "espn-eng.1-" + i, away_team: "Opponent " + i }));
  const away = Array.from({ length: 5 }, (_, i) => ({ ...base, fixture_id: "espn-eng.1-" + (i + 5), home_team: "Rival " + i, away_team: "Away" }));
  const fixtures = [...home, ...away];
  const options = {
    home_team: "Home", away_team: "Away", as_of: "2026-11-02T12:00:00Z",
    league_average_home_goals: 1.5, league_average_away_goals: 1.2,
    league_average_home_half_goals: 0.8, league_average_away_half_goals: 0.5,
  };
  const conflicting = { ...home[0], home_goals: 2, halftime_home_goals: 2 };
  for (const predict of [predictTrustedGoals, predictTrustedHalfTime]) {
    assert.equal(predict(fixtures, options).available, true);
    const result = predict([...fixtures, conflicting], options);
    assert.equal(result.available, false);
    assert.equal(result.reason, "insufficient_verified_venue_sample");
    assert.equal(result.probabilities, undefined);
    assert.equal(result.reasons.conflicting_fixture, 2);
  }
});
