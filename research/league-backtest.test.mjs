import test from 'node:test';
import assert from 'node:assert/strict';
import {backtestByLeague} from './league-backtest.mjs';
const models={'v1.2':{home:.5,draw:.3,away:.2,predictedAt:'2024-12-31T12:00:00Z'},'v1.3':{home:.6,draw:.2,away:.2,predictedAt:'2024-12-31T12:00:00Z'},'v1.4':{home:.7,draw:.2,away:.1,predictedAt:'2024-12-31T12:00:00Z'}};
const row=(i,leagueId)=>({fixtureId:'fixture-'+i,leagueId,date:new Date(Date.UTC(2025,0,i+1)).toISOString(),identity_verified:true,score_verified:true,homeGoals:1,awayGoals:0,models:structuredClone(models)});
test('each league is scored separately on identical verified fixtures',()=>{
 const x=backtestByLeague([...Array.from({length:60},(_,i)=>row(i,'tur.1')),row(61,'eng.1')],{minMatches:30});
 assert.equal(x.leagues['tur.1'].verifiedPairedMatches,60);
 assert.equal(x.leagues['tur.1'].eligibleForRanking,true);
 assert.equal(x.leagues['eng.1'].eligibleForRanking,false);
});
test('missing league identity is rejected',()=>assert.throws(()=>backtestByLeague([{fixtureId:'a'}]),/league identity/));
test('unverified league fixtures cannot meet minimum sample',()=>{
 const x=backtestByLeague(Array.from({length:40},(_,i)=>({...row(i,'tur.1'),score_verified:false})));
 assert.equal(x.leagues['tur.1'].eligibleForRanking,false);
});

test('minimum sample alone cannot rank without chronological holdout',()=>{
 const x=backtestByLeague(Array.from({length:40},(_,i)=>row(i,'tur.1')),{minMatches:30});
 assert.equal(x.leagues['tur.1'].verifiedPairedMatches,40);
 assert.equal(x.leagues['tur.1'].chronologicalHoldout.status,'insufficient_data');
 assert.equal(x.leagues['tur.1'].eligibleForRanking,false);
});

test('league evaluation rejects fixtures without pre-match evidence',()=>{
 const r=row(1,'tur.1');delete r.models['v1.3'].predictedAt;
 const result=backtestByLeague([r]);
 assert.equal(result.leagues['tur.1'].verifiedPairedMatches,0);
 assert.equal(result.leagues['tur.1'].eligibleForRanking,false);
});

test('each fixture owns independent prediction evidence',()=>{
 const first=row(1,'tur.1'),second=row(2,'tur.1');
 delete first.models['v1.3'].predictedAt;
 assert.equal(typeof second.models['v1.3'].predictedAt,'string');
 assert.equal(backtestByLeague([first,second]).leagues['tur.1'].verifiedPairedMatches,1);
});
