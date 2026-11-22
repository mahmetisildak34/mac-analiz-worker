import test from 'node:test';
import assert from 'node:assert/strict';
import {sealMarketEvidence,evaluateMarketEvidence} from './supplementary-market-evidence.mjs';
const kickoff=i=>new Date(Date.UTC(2026,0,i+2)).toISOString();
const input=i=>({fixtureId:'fixture-'+i,leagueId:'tur.1',kickoff:kickoff(i),recordedAt:'2025-12-31T12:00:00Z',featureAvailableAt:'2025-12-31T11:00:00Z',featureSnapshotId:'snapshot',sourceEvidenceId:'source',models:Object.fromEntries(['v1.2','v1.3','v1.4'].map(v=>[v,{codeVersion:'commit-'+v,predictedAt:'2025-12-31T12:00:00Z',firstHalf1X2:{home:.5,draw:.3,away:.2},totalGoals:{line:2.5,over:.45,under:.55}}]))});
const pair=i=>({evidence:sealMarketEvidence(input(i)),result:{fixtureId:'fixture-'+i,leagueId:'tur.1',identity_verified:true,score_verified:true,verifiedAt:'2026-04-01T00:00:00Z',firstHalfVerified:true,firstHalfHomeGoals:1,firstHalfAwayGoals:0,totalGoalsVerified:true,homeGoals:2,awayGoals:1}});
test('sealed pre-kickoff supplementary evidence rejects tampering and post-kickoff timestamps',()=>{
 const good=sealMarketEvidence(input(0));assert.match(good.sha256,/^[a-f0-9]{64}$/);
 assert.throws(()=>sealMarketEvidence({...input(0),recordedAt:kickoff(0)}),/late/);
 const modified=structuredClone(good);modified.models['v1.4'].totalGoals.over=.9;
 assert.equal(evaluateMarketEvidence([{evidence:modified,result:pair(0).result}]).rejected,1);
});
test('50 paired synthetic records score both markets across three models chronologically',()=>{
 const report=evaluateMarketEvidence(Array.from({length:50},(_,i)=>pair(i)));
 for(const market of ['firstHalf1X2','totalGoals']){
  assert.equal(report.markets[market].status,'evaluated');
  assert.equal(report.markets[market].count,50);
  assert.equal(report.markets[market].chronological.holdoutCount,10);
  for(const version of ['v1.2','v1.3','v1.4']){
   assert.ok(Number.isFinite(report.markets[market].models[version].brier));
   assert.ok(Number.isFinite(report.markets[market].models[version].logLoss));
  }
 }
});
test('unverified half-time and total-goals evidence never produce success metrics',()=>{
 const records=Array.from({length:50},(_,i)=>pair(i));
 for(const x of records){x.result.firstHalfVerified=false;x.result.totalGoalsVerified=false;}
 const report=evaluateMarketEvidence(records);
 assert.equal(report.markets.firstHalf1X2.status,'insufficient_verified_data');
 assert.equal(report.markets.totalGoals.status,'insufficient_verified_data');
});
test('duplicates and mismatched total-goal lines cannot inflate paired sample',()=>{
 const a=pair(0),b=pair(1);b.evidence=sealMarketEvidence({...input(1),models:{...input(1).models,'v1.4':{...input(1).models['v1.4'],totalGoals:{line:3.5,over:.4,under:.6}}}});
 const report=evaluateMarketEvidence([a,a,b]);
 assert.equal(report.markets.firstHalf1X2.count,2);
 assert.equal(report.markets.totalGoals.count,1);
 assert.equal(report.rejected,2);
});
