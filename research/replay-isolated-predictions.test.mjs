import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createIsolatedPredictionStore} from './isolated-prediction-store.mjs';
import {replayIsolatedPredictions} from './replay-isolated-predictions.mjs';
const stamp=i=>new Date(Date.UTC(2026,10,23+i,15)).toISOString();
const models=()=>Object.fromEntries(['v1.2','v1.3','v1.4'].map(v=>[v,{home:.5,draw:.3,away:.2,codeVersion:'sha-'+v}]));
const fixture=i=>({fixtureId:'fixture-'+i,leagueId:'tur.1',homeTeamId:'team-a',awayTeamId:'team-b',kickoff:stamp(i),
 featureSnapshotId:'snapshot-'+i,featureAvailableAt:'2026-11-22T10:00:00Z',sourceEvidenceId:'source-'+i,models:models()});
const result=i=>({fixtureId:'fixture-'+i,leagueId:'tur.1',homeTeamId:'team-a',awayTeamId:'team-b',date:stamp(i),
 identity_verified:true,score_verified:true,homeGoals:1,awayGoals:0});
const withDir=async fn=>{const directory=await mkdtemp(join(tmpdir(),'mam-replay-'));try{await fn(directory);}finally{await rm(directory,{recursive:true,force:true});}};
test('missing historical evidence fails closed with no model ranking',async()=>withDir(async directory=>{
 const r=await replayIsolatedPredictions({directory,results:[result(0)]});
 assert.equal(r.status,'insufficient_verified_data');assert.equal(r.comparison,null);
 assert.equal(r.pairedMatches,0);assert.equal(r.rejected.length,1);
}));
test('replay rejects mismatched results and duplicate fixture identities',async()=>withDir(async directory=>{
 const store=createIsolatedPredictionStore({directory,now:()=> '2026-11-22T11:00:00Z'});
 await store.append(fixture(0));
 const r=await replayIsolatedPredictions({directory,results:[result(0),result(0),{...result(1),score_verified:false}],minPaired:1});
 assert.equal(r.status,'insufficient_chronological_holdout');
 assert.equal(r.comparison,null);assert.equal(r.rejected.length,2);
}));
test('50 synthetic persisted pre-match pairs replay with chronological holdout only',async()=>withDir(async directory=>{
 const store=createIsolatedPredictionStore({directory,now:()=> '2026-11-22T11:00:00Z'});
 for(let i=0;i<50;i++)await store.append(fixture(i));
 const r=await replayIsolatedPredictions({directory,results:Array.from({length:50},(_,i)=>result(i))});
 assert.equal(r.status,'evaluated');
 assert.equal(r.pairedMatches,50);
 assert.equal(r.chronologicalHoldout.trainCount,40);
 assert.equal(r.chronologicalHoldout.holdoutCount,10);
 assert.equal(r.comparison.models['v1.2'].count,50);
 assert.deepEqual(r.rejected,[]);
}));
