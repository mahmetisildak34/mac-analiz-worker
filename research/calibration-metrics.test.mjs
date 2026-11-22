import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateCalibration,comparePairedModels} from './calibration-metrics.mjs';
const p=(home,draw,away)=>({home,draw,away});
test('perfect confident predictions have zero losses',()=>{
 const x=evaluateCalibration([{probabilities:p(1,0,0),outcome:'home'},{probabilities:p(0,1,0),outcome:'draw'}]);
 assert.equal(x.count,2);assert.equal(x.brier,0);assert.equal(x.logLoss,0);assert.equal(x.accuracy,1);assert.equal(x.ece,0);
});
test('uniform predictions have known Brier and log loss',()=>{
 const x=evaluateCalibration([{probabilities:p(1/3,1/3,1/3),outcome:'away'}]);
 assert.ok(Math.abs(x.brier-2/3)<1e-12);
 assert.ok(Math.abs(x.logLoss-Math.log(3))<1e-12);
});
test('empty evaluation has no fabricated performance',()=>{
 const x=evaluateCalibration([]);assert.equal(x.count,0);
 for(const k of ['brier','logLoss','accuracy','ece'])assert.equal(x[k],null);
});
test('invalid or inconsistent probability inputs fail closed',()=>{
 for(const probabilities of [p(.5,.5,.5),p(NaN,.5,.5),p(-.1,.5,.6),p(.2,.3,Infinity)])
  assert.throws(()=>evaluateCalibration([{probabilities,outcome:'home'}]),RangeError);
 assert.throws(()=>evaluateCalibration([{probabilities:p(1,0,0),outcome:'unknown'}]),RangeError);
});
test('paired model comparison uses exactly the same fixtures',()=>{
 const rows=[{outcome:'home',models:{'v1.2':p(.5,.3,.2),'v1.3':p(.7,.2,.1),'v1.4':p(.9,.05,.05)}}];
 const x=comparePairedModels(rows);
 assert.equal(x.pairedMatches,1);
 assert.ok(x.models['v1.4'].brier<x.models['v1.3'].brier);
 assert.ok(x.models['v1.3'].brier<x.models['v1.2'].brier);
 assert.throws(()=>comparePairedModels([{outcome:'home',models:{'v1.2':p(1,0,0)}}]),RangeError);
});
