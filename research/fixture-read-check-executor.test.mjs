import test from 'node:test';
import assert from 'node:assert/strict';
import {executeFixtureReadChecks} from './fixture-read-check-executor.mjs';
const nowMs=Date.parse('2026-11-22T18:00:00Z');
const fixture=id=>({fixture_id:id,source:'ESPN',status:'FT',kickoff:'2026-11-22T14:00:00Z',home_goals:1,away_goals:0,statistics_json:null});
test('read adapter receives only identity and abort signal; no production writes',async()=>{
 const calls=[];
 const r=await executeFixtureReadChecks([fixture('a'),fixture('b')],{nowMs,readFixture:async args=>{calls.push(args.fixtureId);return {status:'ok'};}});
 assert.deepEqual(calls.sort(),['a','b']);assert.equal(r.productionWrites,0);assert.equal(r.results.length,2);assert.equal(r.metrics.upstreamCalls,2);
});
test('deduplicates, budgets, and never calls adapter for deferred matches',async()=>{
 let calls=0;
 const r=await executeFixtureReadChecks([fixture('b'),fixture('a'),fixture('a')],{nowMs,maxChecks:1,readFixture:async()=>{calls++;return true;}});
 assert.equal(calls,1);assert.equal(r.results[0].fixtureId,'a');assert.equal(r.deferred,1);
});
test('provider failure is recorded without failing entire batch',async()=>{
 const r=await executeFixtureReadChecks([fixture('a'),fixture('b')],{nowMs,readFixture:async({fixtureId})=>{if(fixtureId==='a')throw Error('offline');return true;}});
 assert.deepEqual(r.results.map(x=>x.status),['failed','read']);assert.equal(r.metrics.upstreamFailures,1);
});
test('invalid adapters and concurrency fail closed',async()=>{
 await assert.rejects(executeFixtureReadChecks([]),/Invalid/);
 await assert.rejects(executeFixtureReadChecks([],{readFixture:async()=>true,concurrency:0}),/Invalid/);
});
test('timeout aborts an adapter and returns a failed result',async()=>{
 let aborted=false;
 const r=await executeFixtureReadChecks([fixture('a')],{nowMs,timeoutMs:5,readFixture:({signal})=>new Promise(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve(null);},{once:true}))});
 assert.equal(aborted,true);assert.equal(r.results[0].status,'failed');
});
