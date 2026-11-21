import assert from "node:assert/strict";
import test from "node:test";
import { pairedOutcomeDiagnostics } from "../scripts/poisson-paired-diagnostics.mjs";

test("paired diagnostics preserve score outcome, game-day grouping and delta direction", () => {
  const map = { current: { outcome: [0.6, 0.2, 0.2] }, alternative: { outcome: [0.4, 0.4, 0.2] } };
  const report = pairedOutcomeDiagnostics([
    { target: { kickoff: "2025-07-01", home_goals: 2, away_goals: 1 }, map },
    { target: { kickoff: "2025-07-02", home_goals: 0, away_goals: 0 }, map },
    { target: { kickoff: "2025-07-02", home_goals: 1, away_goals: 1 }, map },
  ], "alternative");
  assert.equal(report.n, 3);
  assert.equal(report.kickoff_days, 2);
  assert(report.per_result.home.mean_delta > 0);
  assert(report.per_result.draw.mean_delta < 0);
  assert.deepEqual(report.per_result.away, { n: 0, mean_delta: null });
  assert(report.leave_one_day_out.min < 0);
  assert(report.leave_one_day_out.max > 0);
});
