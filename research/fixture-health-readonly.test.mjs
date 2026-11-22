import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyFixtureHealth,summarizeFixtureHealth} from './fixture-health-readonly.mjs';
const nowMs=Date.parse('2026-11-22T18:00:00Z');
const base={fixture_id:'espn-tur.1-123',source:'ESPN',status:'FT',kickoff:'2026-11-22T14:00:00Z',home_goals:2,away_goals:0,statistics_json:JSON.stringify({provider:'ESPN',independentCrossSourceVerification:false})};
test('ESPN-only final evidence remains flagged as not independently verified',()=>{
 const r=classifyFixtureHealth(base,{nowMs});assert.deepEqual(r.issues,['not_independently_verified']);assert.equal(r.priority,'review');
});
test('final fixture without statistics is not silently treated as complete',()=>{
 const r=classifyFixtureHealth({...base,statistics_json:null},{nowMs});assert.ok(r.issues.includes('final_statistics_missing_or_unverified'));
});
test('bad JSON and missing final score are errors',()=>{
 const r=classifyFixtureHealth({...base,statistics_json:'{',home_goals:null},{nowMs});
 assert.equal(r.priority,'error');assert.ok(r.issues.includes('invalid_statistics_json'));assert.ok(r.issues.includes('final_score_missing_or_invalid'));
});
test('stale live fixture is flagged without making provider calls',()=>{
 const r=classifyFixtureHealth({...base,status:'LIVE',lastCheckedAt:'2026-11-22T17:30:00Z'},{nowMs});
 assert.ok(r.issues.includes('live_data_stale_or_unchecked'));
});
test('fresh live fixture is not flagged as stale',()=>{
 const r=classifyFixtureHealth({...base,status:'LIVE',lastCheckedAt:'2026-11-22T17:59:00Z'},{nowMs});
 assert.equal(r.issues.includes('live_data_stale_or_unchecked'),false);
});
test('invalid timestamps and missing identity fail closed',()=>{
 const r=classifyFixtureHealth({...base,kickoff:'bad',fixture_id:''},{nowMs});
 assert.equal(r.priority,'error');assert.ok(r.issues.includes('invalid_kickoff'));assert.ok(r.issues.includes('missing_identity'));
});
test('health summary counts each severity without mutating input',()=>{
 const rows=[base,{...base,statistics_json:null},{...base,home_goals:-1}];
 const r=summarizeFixtureHealth(rows,{nowMs});assert.equal(r.total,3);assert.equal(r.review,2);assert.equal(r.error,1);assert.equal(rows[0].status,'FT');
});
