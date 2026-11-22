import test from 'node:test';
import assert from 'node:assert/strict';
import {planFixtureChecks} from './fixture-check-planner.mjs';
const nowMs=Date.parse('2026-11-22T18:00:00Z');
const row=(id,changes={})=>({fixture_id:id,source:'ESPN',status:'FT',kickoff:'2026-11-22T15:00:00Z',home_goals:1,away_goals:0,statistics_json:null,...changes});
test('missing final statistics schedules read-only check but does not call providers',()=>{
 const r=planFixtureChecks([row('a')],{nowMs});assert.equal(r.mode,'plan-only');assert.equal(r.providerRequests,0);assert.equal(r.selected[0].fixtureId,'a');
});
test('duplicate fixtures cannot trigger repeated checks',()=>{
 const r=planFixtureChecks([row('a'),row('a')],{nowMs});assert.equal(r.selected.length,1);assert.equal(r.skipped[0].reason,'missing_or_duplicate_identity');
});
test('recent checks respect cooldown',()=>{
 const r=planFixtureChecks([row('a',{lastCheckedAt:'2026-11-22T17:59:00Z'})],{nowMs});assert.equal(r.selected.length,0);assert.equal(r.skipped[0].reason,'retry_cooldown');
});
test('budget limits planned checks and retains deferred records',()=>{
 const r=planFixtureChecks([row('c'),row('a'),row('b')],{nowMs,maxChecks:1});assert.deepEqual(r.selected.map(x=>x.fixtureId),['a']);assert.equal(r.deferred.length,2);
});
test('invalid configuration fails closed',()=>{
 assert.throws(()=>planFixtureChecks([], {maxChecks:-1}),/Invalid/);
 assert.throws(()=>planFixtureChecks([], {minRetryMs:0}),/Invalid/);
});
