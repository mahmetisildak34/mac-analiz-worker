import test from 'node:test';
import assert from 'node:assert/strict';
import {compareVerifiedPredictions} from './verified-model-comparison.mjs';
const p=(home,draw,away)=>({home,draw,away,predictedAt:'2026-11-21T10:00:00Z'});
const pair={fixtureId:'401',leagueId:'tur.1',date:'2026-11-21T18:00:00Z',identity_verified:true,score_verified:true,
 predictionEvidenceSha256:'a'.repeat(64),homeGoals:2,awayGoals:1,
 models:{'v1.2':p(.6,.2,.2),'v1.3':p(.4,.3,.3),'v1.4':p(.8,.1,.1)}};
test('Brier and log loss compare the same verified match for all three versions',()=>{
 const r=compareVerifiedPredictions([pair],{minSamples:2});
 assert.equal(r.defaultModel,'v1.2');assert.equal(r.totalVerifiedPairs,1);
 assert.equal(r.leagues['tur.1'].status,'insufficient_sample');
 assert.ok(r.leagues['tur.1'].models['v1.4'].brierScore<r.leagues['tur.1'].models['v1.2'].brierScore);
 assert.ok(r.leagues['tur.1'].models['v1.4'].logLoss<r.leagues['tur.1'].models['v1.3'].logLoss);
 assert.ok(Math.abs(r.leagues['tur.1'].models['v1.2'].logLoss+Math.log(.6))<1e-12);
});
test('comparison refuses duplicates, unverified results and late predictions',()=>{
 assert.throws(()=>compareVerifiedPredictions([pair,pair]),/Duplicate/);
 assert.throws(()=>compareVerifiedPredictions([{...pair,score_verified:false}]),/Unverified/);
 assert.throws(()=>compareVerifiedPredictions([{...pair,models:{...pair.models,'v1.2':{...pair.models['v1.2'],predictedAt:pair.date}}}]),/late/);
 assert.throws(()=>compareVerifiedPredictions([{...pair,models:{...pair.models,'v1.2':p(.7,.2,.2)}}]),/Invalid/);
 assert.equal(compareVerifiedPredictions([]).totalVerifiedPairs,0);
});
