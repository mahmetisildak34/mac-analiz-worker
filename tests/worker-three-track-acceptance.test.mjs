import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyStatisticsCandidate} from '../verified-statistics-candidate.js';
import {fetchVerifiedWithFallback,SourceUnavailableError} from '../research/verified-source-fallback.mjs';
import {compareVerifiedPredictions} from '../research/verified-model-comparison.mjs';
import {createRequestCoordinator} from '../research/request-coordinator.mjs';

const fixture={source:'api-football',fixture_id:'501',status:'FT',kickoff:'2026-11-20T18:00:00Z',home_team_id:10,away_team_id:20,home_team:'Home',away_team:'Away',home_goals:2,away_goals:1};
const stats=[['Total Shots',12],['Shots on Target',5],['Ball Possession','55%'],['Corner Kicks',4],['Fouls',10],['Yellow Cards',2],['Red Cards',0]];
const evidence={source:fixture.source,fixture_id:fixture.fixture_id,provider:'api-sports',provider_verified:true,identity_verified:true,kickoff:fixture.kickoff,home_goals:2,away_goals:1,teams:[
 {homeAway:'home',team:{id:10,name:'Home'},statistics:stats.map(([type,value])=>({type,value}))},
 {homeAway:'away',team:{id:20,name:'Away'},statistics:stats.map(([type,value],i)=>({type,value:i===2?'45%':value}))}
]};
test('statistics: contradictory identity cannot be rescued by valid-looking metrics',()=>{
 const forged=structuredClone(evidence);forged.teams[0].team.id=999;
 assert.equal(verifyStatisticsCandidate(fixture,forged).state,'rejected');
 assert.equal(verifyStatisticsCandidate(fixture,forged).reason,'team_id_mismatch');
});
test('sources: a verified fallback is admitted only after identity validation',async()=>{
 let calls=0;
 const result=await fetchVerifiedWithFallback([
  {name:'primary',fetch:async()=>{calls++;return {...evidence,fixture_id:'999'}}},
  {name:'backup',fetch:async()=>{calls++;return structuredClone(evidence)}}
 ],{validate:data=>verifyStatisticsCandidate(fixture,data).state==='verified'});
 assert.equal(result.source,'backup');assert.equal(calls,2);
 assert.equal(verifyStatisticsCandidate(fixture,result.data).state,'verified');
});
test('sources: two unverified candidates cannot fabricate a completed fixture',async()=>{
 await assert.rejects(fetchVerifiedWithFallback([
  {name:'primary',fetch:async()=>({...evidence,provider_verified:false})},
  {name:'backup',fetch:async()=>({...evidence,home_goals:9})}
 ],{validate:data=>verifyStatisticsCandidate(fixture,data).state==='verified'}),SourceUnavailableError);
});
test('Poisson: no unverified or late outcome may enter the three-model report',()=>{
 const p=(home,draw,away)=>({home,draw,away,predictedAt:'2026-11-20T10:00:00Z'});
 const pair={fixtureId:fixture.fixture_id,leagueId:'tur.1',date:fixture.kickoff,identity_verified:true,score_verified:true,predictionEvidenceSha256:'a'.repeat(64),homeGoals:2,awayGoals:1,models:{'v1.2':p(.5,.3,.2),'v1.3':p(.6,.2,.2),'v1.4':p(.7,.2,.1)}};
 const report=compareVerifiedPredictions([pair],{minSamples:30});
 assert.equal(report.defaultModel,'v1.2');
 assert.equal(report.leagues['tur.1'].status,'insufficient_sample');
 assert.throws(()=>compareVerifiedPredictions([{...pair,score_verified:false}]));
 assert.throws(()=>compareVerifiedPredictions([{...pair,models:{...pair.models,'v1.4':{...pair.models['v1.4'],predictedAt:fixture.kickoff}}}]));
});
test('performance: simultaneous identical requests share one upstream result',async()=>{
 const coordinator=createRequestCoordinator();let upstream=0;
 const requests=Array.from({length:24},()=>coordinator.run('same-fixture',async()=>{upstream++;await new Promise(resolve=>setTimeout(resolve,10));return {id:501}},{ttlMs:1000}));
 const results=await Promise.all(requests);
 assert.equal(upstream,1);assert.ok(results.every(x=>x.id===501));
});
