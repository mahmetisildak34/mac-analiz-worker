import test from 'node:test';
import assert from 'node:assert/strict';
import {backtest,prepareVerifiedPairs} from './run-paired-backtest.mjs';
const p=(home,draw,away)=>({home,draw,away});
const models={'v1.2':p(.5,.3,.2),'v1.3':p(.7,.2,.1),'v1.4':p(.9,.05,.05)};
test('only identity and score verified fixtures are evaluated',()=>{
 const good={fixtureId:'match-1',identity_verified:true,score_verified:true,homeGoals:2,awayGoals:1,models};
 const x=backtest([good,{...good,fixtureId:'match-2',score_verified:false},{...good,fixtureId:'match-3',models:{'v1.2':models['v1.2']}}]);
 assert.equal(x.status,'evaluated');assert.equal(x.verifiedPairedMatches,1);assert.equal(x.excluded,2);
 assert.ok(x.comparison.models['v1.4'].brier<x.comparison.models['v1.2'].brier);
});
test('empty verified data cannot produce fabricated model rankings',()=>{
 const x=backtest([{fixtureId:'x',identity_verified:false,score_verified:true,homeGoals:1,awayGoals:0,models}]);
 assert.equal(x.status,'insufficient_verified_data');assert.equal(x.comparison,null);
});
test('duplicate fixture IDs fail rather than inflate sample size',()=>{
 const row={fixtureId:'same',identity_verified:true,score_verified:true,homeGoals:0,awayGoals:0,models};
 assert.throws(()=>prepareVerifiedPairs([row,row]),/Duplicate verified fixture/);
});
test('negative or fractional scores are excluded',()=>{
 const row={fixtureId:'a',identity_verified:true,score_verified:true,homeGoals:-1,awayGoals:0,models};
 assert.equal(backtest([row]).verifiedPairedMatches,0);
});
