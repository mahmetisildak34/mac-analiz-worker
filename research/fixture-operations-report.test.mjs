import test from 'node:test';
import assert from 'node:assert/strict';
import {buildFixtureOperationsReport} from './fixture-operations-report.mjs';
test('offline operations report preserves default model and never requests providers',()=>{
 const nowMs=Date.parse('2026-11-22T18:00:00Z');
 const rows=[{fixture_id:'espn-tur.1-1',source:'ESPN',status:'FT',kickoff:'2026-11-22T14:00:00Z',home_goals:2,away_goals:0,statistics_json:null}];
 const report=buildFixtureOperationsReport(rows,{nowMs,maxChecks:1});
 assert.equal(report.defaultModel,'v1.2');assert.equal(report.providerRequests,0);assert.equal(report.productionWrites,0);
 assert.equal(report.health.review,1);assert.equal(report.checkPlan.selected.length,1);
 assert.equal(report.checkPlan.selected[0].fixtureId,'espn-tur.1-1');
});
test('invalid input fails closed',()=>assert.throws(()=>buildFixtureOperationsReport(null),/Rows must be an array/));
