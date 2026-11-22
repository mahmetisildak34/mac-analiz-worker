import test from 'node:test';
import assert from 'node:assert/strict';
import {backtestByLeague} from './league-backtest.mjs';
const models={'v1.2':{home:.5,draw:.3,away:.2},'v1.3':{home:.6,draw:.2,away:.2},'v1.4':{home:.7,draw:.2,away:.1}};
const row=(i,leagueId)=>({fixtureId:'fixture-'+i,leagueId,date:new Date(Date.UTC(2025,0,i+1)).toISOString(),identity_verified:true,score_verified:true,homeGoals:1,awayGoals:0,models});
test('each league is scored separately on identical verified fixtures',()=>{
 const x=backtestByLeague([...Array.from({length:40},(_,i)=>row(i,'tur.1')),row(41,'eng.1')],{minMatches:30});
 assert.equal(x.leagues['tur.1'].verifiedPairedMatches,40);
 assert.equal(x.leagues['tur.1'].eligibleForRanking,true);
 assert.equal(x.leagues['eng.1'].eligibleForRanking,false);
});
test('missing league identity is rejected',()=>assert.throws(()=>backtestByLeague([{fixtureId:'a'}]),/league identity/));
test('unverified league fixtures cannot meet minimum sample',()=>{
 const x=backtestByLeague(Array.from({length:40},(_,i)=>({...row(i,'tur.1'),score_verified:false})));
 assert.equal(x.leagues['tur.1'].eligibleForRanking,false);
});
