import test from "node:test";
import assert from "node:assert/strict";
import { evaluatePriorityLeagueCoverage as evaluate } from "../scripts/priority-league-audit.mjs";

function payload() {
  return {
    ok: true, truncated: false, priorityLeagueDirectoryErrors: [],
    priorityLeagueCoverage: [39, 203, 140, 78, 135, 61, 2, 3, 88, 94, 848].map(leagueId => ({
      leagueId, directoryVerified: true, teamsBelow10: 0,
      missingUpcomingInD1: [], d1UpcomingNotInProvider: [],
    })),
  };
}

test("a complete report passes and the four production-style deficits fail by league ID", () => {
  const report = payload();
  assert.deepEqual(evaluate(report), { errors: [], incomplete: [] });
  const deficits = new Map([[78, 2], [2, 11], [3, 21], [848, 36]]);
  for (const row of report.priorityLeagueCoverage) row.teamsBelow10 = deficits.get(row.leagueId) ?? 0;
  const conference = report.priorityLeagueCoverage.at(-1);
  conference.missingUpcomingInD1 = Array.from({ length: 18 }, (_, id) => ({ id }));
  assert.deepEqual(evaluate(report), { errors: [], incomplete: ["78", "2", "3", "848"] });
  conference.teamsBelow10 = 0;
  assert.ok(evaluate(report).incomplete.includes("848"));
});

test("missing, truncated, malformed, duplicate and failed source reports cannot pass", () => {
  assert.ok(evaluate({ ok: true }).errors.length);
  for (const mutate of [
    r => r.priorityLeagueCoverage.pop(),
    r => { r.truncated = true; },
    r => { delete r.priorityLeagueCoverage[0].teamsBelow10; },
    r => r.priorityLeagueCoverage.push(r.priorityLeagueCoverage[0]),
    r => r.priorityLeagueDirectoryErrors.push({ leagueId: "848" }),
  ]) {
    const report = payload();
    mutate(report);
    assert.ok(evaluate(report).errors.length);
  }
});
