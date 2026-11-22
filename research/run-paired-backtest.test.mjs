import test from 'node:test';
import assert from 'node:assert/strict';
import {backtest,prepareVerifiedPairs} from './run-paired-backtest.mjs';
const p=(home,draw,away)=>({home,draw,away});
const models={'v1.2':p(.5,.3,.2),'v1.3':p(.7,.2,.1),'v1.4':p(.9,.05,.05)};
test('only identity and score verified fixtures are evaluated',()=>{
 const good={fixtureId:'match-1',date:'2025-01-01T00:00:00Z',identity_verified:true,score_verified:true,homeGoals:2,awayGoals:1,models};
 const x=backtest([good,{...good,fixtureId:'match-2',score_verified:false},{...good,fixtureId:'match-3',models:{'v1.2':models['v1.2']}}]);
 assert.equal(x.status,'evaluated');assert.equal(x.verifiedPairedMatches,1);assert.equal(x.excluded,2);
 assert.ok(x.comparison.models['v1.4'].brier<x.comparison.models['v1.2'].brier);
});
test('empty verified data cannot produce fabricated model rankings',()=>{
 const x=backtest([{fixtureId:'x',date:'2025-01-01T00:00:00Z',identity_verified:false,score_verified:true,homeGoals:1,awayGoals:0,models}]);
 assert.equal(x.status,'insufficient_verified_data');assert.equal(x.comparison,null);
});
test('duplicate fixture IDs fail rather than inflate sample size',()=>{
 const row={fixtureId:'same',date:'2025-01-01T00:00:00Z',identity_verified:true,score_verified:true,homeGoals:0,awayGoals:0,models};
 assert.throws(()=>prepareVerifiedPairs([row,row]),/Duplicate verified fixture/);
});
test('negative or fractional scores are excluded',()=>{
 const row={fixtureId:'a',date:'2025-01-01T00:00:00Z',identity_verified:true,score_verified:true,homeGoals:-1,awayGoals:0,models};
 assert.equal(backtest([row]).verifiedPairedMatches,0);
});

test('backtest preserves dates for chronological holdout and rejects missing dates',()=>{
 const rows=Array.from({length:50},(_,i)=>({fixtureId:'fixture-'+i,date:new Date(Date.UTC(2025,0,i+1)).toISOString(),identity_verified:true,score_verified:true,homeGoals:2,awayGoals:0,models}));
 const result=backtest(rows);
 assert.equal(result.chronologicalHoldout.status,'evaluated');
 assert.equal(result.chronologicalHoldout.holdoutCount,10);
 assert.equal(backtest([{...rows[0],date:null}]).status,'insufficient_verified_data');
});
