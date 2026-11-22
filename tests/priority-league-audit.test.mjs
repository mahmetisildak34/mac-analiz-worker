import assert from "node:assert/strict";
import test from "node:test";
import {assessPriorityCoverage} from "../scripts/priority-league-audit.mjs";

const healthy = () => ({ok:true, priorityLeagueCoverage:["39","203","140","78","135","61","2","3","88","94","848"].map(leagueId => ({
  leagueId, directoryVerified:true, teamsBelow10:0, missingUpcomingInD1:[], d1UpcomingNotInProvider:[]
}))});

test("healthy priority coverage passes", () => assert.deepEqual(assessPriorityCoverage(healthy()), []));

test("insufficient history and missing fixtures are separate failures", () => {
  const report = healthy();
  Object.assign(report.priorityLeagueCoverage.at(-1), {teamsBelow10:36,missingUpcomingInD1:[{}]});
  assert.deepEqual(assessPriorityCoverage(report), [{
    leagueId:"848", leagueName:undefined, directoryVerified:true,
    teamsBelow10:36, missingUpcoming:1, extraUpcoming:0
  }]);
});

test("missing league, non-boolean status or malformed report fails closed", () => {
  const report = healthy();
  report.priorityLeagueCoverage.pop();
  assert.throws(() => assessPriorityCoverage(report), /required league/);
  const invalid = healthy();
  invalid.priorityLeagueCoverage[0].directoryVerified = "true";
  assert.throws(() => assessPriorityCoverage(invalid), /coverage fields/);
  assert.throws(() => assessPriorityCoverage({ok:true}), /valid coverage report/);
});
