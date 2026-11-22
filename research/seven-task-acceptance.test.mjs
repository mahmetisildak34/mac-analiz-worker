import test from 'node:test';
import assert from 'node:assert/strict';
import {calibrateVerifiedLeagues} from './verified-league-calibration.mjs';
import {compareVerifiedPredictions} from './verified-model-comparison.mjs';
import {createRequestCoordinator} from './request-coordinator.mjs';
import {classifyFixtureHealth} from './fixture-health-readonly.mjs';
import {executeFixtureReadChecks} from './fixture-read-check-executor.mjs';

const prediction={home:.5,draw:.3,away:.2,predictedAt:'2026-11-21T12:00:00Z'};
const fixture=(leagueId='tur.1')=>({fixtureId:'401',leagueId,date:'2026-11-22T14:00:00Z',identity_verified:true,score_verified:true,predictionEvidenceSha256:'a'.repeat(64),homeGoals:1,awayGoals:0,models:{'v1.2':prediction,'v1.3':prediction,'v1.4':prediction}});

test('same ESPN numeric fixture ID in different leagues remains independent for calibration',()=>{
 const a=fixture('tur.1'),b=fixture('eng.1');
 const result=calibrateVerifiedLeagues([a,b],{minSamples:30});
 assert.equal(result.totalVerifiedPairs,2);
 assert.equal(result.leagues['tur.1'].sampleSize,1);
 assert.equal(result.leagues['eng.1'].sampleSize,1);
 assert.equal(result.leagues['tur.1'].status,'insufficient_sample');
 assert.equal(result.defaultModel,'v1.2');
});
test('actual duplicate within one league still fails closed',()=>{
 assert.throws(()=>calibrateVerifiedLeagues([fixture(),fixture()]),/Duplicate fixture/);
});
test('all model versions reject late predictions, default stays v1.2',()=>{
 const late={...prediction,predictedAt:'2026-11-22T14:00:00Z'};
 for(const version of ['v1.2','v1.3','v1.4']){
  const row=fixture();row.models={...row.models,[version]:late};
  assert.throws(()=>compareVerifiedPredictions([row]),/late/);
  assert.throws(()=>calibrateVerifiedLeagues([row]),/late/);
 }
 assert.equal(compareVerifiedPredictions([fixture()]).defaultModel,'v1.2');
});
test('unverified scores cannot enter the paired model benchmark',()=>{
 assert.throws(()=>compareVerifiedPredictions([{...fixture(),score_verified:false}]),/Unverified/);
});
test('80 concurrent ESPN requests to the same fixture use one upstream operation',async()=>{
 const c=createRequestCoordinator();let calls=0;
 const tasks=Array.from({length:80},()=>c.run('tur.1:401',async()=>{calls++;await Promise.resolve();return {ok:true};},{provider:'ESPN',ttlMs:1000,limit:2,windowMs:60000}));
 const values=await Promise.all(tasks);
 assert.equal(calls,1);assert.equal(values.length,80);
 assert.equal(c.stats().coalesced,79);
 assert.equal(c.stats().upstreamCalls,1);
});
test('80 sequential repeat calls hit TTL cache without increasing provider usage',async()=>{
 let now=100,calls=0;
 const c=createRequestCoordinator({now:()=>now});
 for(let i=0;i<80;i++)await c.run('tur.1:401',()=>++calls,{provider:'ESPN',ttlMs:500,limit:1,windowMs:500});
 assert.equal(calls,1);assert.equal(c.stats().cacheHits,79);
 now=600;assert.equal(await c.run('tur.1:401',()=>++calls,{provider:'ESPN',ttlMs:500,limit:1,windowMs:500}),2);
});
test('quota exhaustion never calls an extra upstream provider',async()=>{
 let calls=0;const c=createRequestCoordinator({now:()=>0});
 await c.run('a',()=>++calls,{provider:'ESPN',limit:1,windowMs:60000});
 await assert.rejects(c.run('b',()=>++calls,{provider:'ESPN',limit:1,windowMs:60000}),/quota exhausted/);
 assert.equal(calls,1);assert.equal(c.stats().quotaRejected,1);
});
test('failed provider responses cannot be cached as success',async()=>{
 let calls=0;const c=createRequestCoordinator();
 await assert.rejects(c.run('x',()=>{calls++;throw Error('503');},{provider:'ESPN',ttlMs:60000}),/503/);
 assert.equal(await c.run('x',()=>{calls++;return 'ok';},{provider:'ESPN',ttlMs:60000}),'ok');
 assert.equal(calls,2);
});
test('final fixture with malformed statistics JSON is flagged, not verified',()=>{
 const row={source:'ESPN',fixture_id:'401',status:'FT',kickoff:'2026-11-22T12:00:00Z',home_goals:2,away_goals:1,statistics_json:'{bad json'};
 const r=classifyFixtureHealth(row,{nowMs:Date.parse('2026-11-22T16:00:00Z')});
 assert.equal(r.priority,'error');assert.ok(r.issues.includes('invalid_statistics_json'));
});
test('structurally valid ESPN statistics without independent cross-source proof stay under review',()=>{
 const row={source:'ESPN',fixture_id:'401',status:'FT',kickoff:'2026-11-22T12:00:00Z',home_goals:2,away_goals:1,statistics_json:JSON.stringify({independentCrossSourceVerification:false})};
 const r=classifyFixtureHealth(row,{nowMs:Date.parse('2026-11-22T16:00:00Z')});
 assert.equal(r.priority,'review');assert.ok(r.issues.includes('not_independently_verified'));
});
test('read-check executor limits workload and reports zero production writes',async()=>{
 const nowMs=Date.parse('2026-11-22T18:00:00Z');let calls=0;
 const rows=Array.from({length:40},(_,i)=>({source:'ESPN',fixture_id:'fixture-'+String(i).padStart(2,'0'),status:'FT',kickoff:'2026-11-22T14:00:00Z',home_goals:1,away_goals:0,statistics_json:null}));
 const report=await executeFixtureReadChecks(rows,{nowMs,maxChecks:6,concurrency:3,readFixture:async()=>{calls++;return {readOnly:true};}});
 assert.equal(calls,6);assert.equal(report.planned,6);assert.equal(report.deferred,34);assert.equal(report.productionWrites,0);
});
