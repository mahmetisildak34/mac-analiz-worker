import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectIsolatedFixtureHealth} from './inspect-isolated-fixture-health.mjs';
const nowMs=Date.parse('2026-11-22T18:00:00Z');
const fixture={fixture_id:'espn-tur.1-1',source:'ESPN',status:'FT',kickoff:'2026-11-22T14:00:00Z',home_goals:2,away_goals:1,statistics_json:JSON.stringify({provider:'ESPN',independentCrossSourceVerification:false})};
const fetcher=rows=>async(url,init)=>{assert.match(url,/fb9b42cc-8d96-4911-b193-0983527ee593/);assert.equal(init.method,'POST');const {sql}=JSON.parse(init.body);assert.match(sql,/^SELECT /);assert.doesNotMatch(sql,/\b(?:UPDATE|DELETE|INSERT|DROP)\b/i);return {ok:true,json:async()=>({success:true,result:[{results:rows}]})};};
test('isolated D1 report flags ESPN-only verification without writing',async()=>{
 const r=await inspectIsolatedFixtureHealth({token:'fake-test-token',fetcher:fetcher([fixture]),nowMs});
 assert.equal(r.queryRows,1);assert.equal(r.health.review,1);assert.equal(r.providerRequests,0);assert.equal(r.productionWrites,0);assert.equal(r.defaultModel,'v1.2');
});
test('reject missing dedicated token',async()=>assert.rejects(inspectIsolatedFixtureHealth({fetcher:fetcher([])}),/token/));
test('reject failed D1 response',async()=>assert.rejects(inspectIsolatedFixtureHealth({token:'fake',fetcher:async()=>({ok:false,json:async()=>({success:false})})}),/failed/));
test('reject truncated D1 data',async()=>assert.rejects(inspectIsolatedFixtureHealth({token:'fake',fetcher:fetcher(Array.from({length:500},(_,i)=>({...fixture,fixture_id:String(i)})))}),/row cap/));
