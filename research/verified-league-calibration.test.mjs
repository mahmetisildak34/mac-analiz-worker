import test from 'node:test';
import assert from 'node:assert/strict';
import {calibrateVerifiedLeagues} from './verified-league-calibration.mjs';
const model={home:.6,draw:.2,away:.2,predictedAt:'2026-11-21T10:00:00Z'};
const pair={fixtureId:'401',leagueId:'tur.1',date:'2026-11-21T18:00:00Z',identity_verified:true,score_verified:true,predictionEvidenceSha256:'a'.repeat(64),homeGoals:2,awayGoals:1,models:{'v1.2':model,'v1.3':model,'v1.4':model}};
test('verified league calibration includes per-bin confidence intervals and sample warning',()=>{
 const r=calibrateVerifiedLeagues([pair]);
 assert.equal(r.totalVerifiedPairs,1);assert.equal(r.defaultModel,'v1.2');
 assert.equal(r.leagues['tur.1'].status,'insufficient_sample');
 const m=r.leagues['tur.1'].models['v1.2'];
 assert.equal(m.count,1);assert.ok(m.reliability.some(b=>b.count===1&&b.accuracy95CI.lower>=0&&b.accuracy95CI.upper<=1));
});
test('rejects late, unverified, and duplicate evidence',()=>{
 assert.throws(()=>calibrateVerifiedLeagues([{...pair,score_verified:false}]),/Unverified/);
 assert.throws(()=>calibrateVerifiedLeagues([pair,pair]),/Duplicate/);
 assert.throws(()=>calibrateVerifiedLeagues([{...pair,models:{...pair.models,'v1.4':{...model,predictedAt:pair.date}}}]),/late/);
 assert.equal(calibrateVerifiedLeagues([]).totalVerifiedPairs,0);
});
