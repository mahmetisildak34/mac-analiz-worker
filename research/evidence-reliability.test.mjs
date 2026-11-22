import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateEvidenceReliability,wilsonInterval} from './evidence-reliability.mjs';
const models=()=>Object.fromEntries(['v1.2','v1.3','v1.4'].map((v,i)=>[v,{home:.5+i*.05,draw:.3-i*.025,away:.2-i*.025,predictedAt:'2025-01-01T00:00:00Z'}]));
const fixture=i=>({fixtureId:'match-'+i,date:new Date(Date.UTC(2025,0,i+2)).toISOString(),leagueId:i%2?'tur.1':'eng.1',
 identity_verified:true,score_verified:true,homeGoals:i%3===0?0:2,awayGoals:i%3===0?1:0,models:models()});
test('empty, late and unverified evidence never produce reliability claims',()=>{
 const empty=evaluateEvidenceReliability([]);
 assert.equal(empty.status,'insufficient_verified_data');assert.equal(empty.overall.comparison,null);
 const late=fixture(0);late.models['v1.3'].predictedAt=late.date;
 const report=evaluateEvidenceReliability([late,{...fixture(1),score_verified:false}]);
 assert.equal(report.verifiedPairedMatches,0);assert.equal(report.overall.comparison,null);
});
test('50 synthetic fixtures exercise paired 1X2 metrics, Wilson bounds and chronological holdout',()=>{
 const report=evaluateEvidenceReliability(Array.from({length:50},(_,i)=>fixture(i)));
 assert.equal(report.status,'evaluated');
 assert.equal(report.overall.comparison.pairedMatches,50);
 assert.equal(report.chronological.holdoutCount,10);
 assert.equal(report.byLeague['tur.1'].count,25);
 assert.equal(report.byLeague['eng.1'].count,25);
 assert.equal(report.byOutcome.home.count+report.byOutcome.away.count,50);
 for(const v of ['v1.2','v1.3','v1.4']){
  assert.ok(Number.isFinite(report.overall.comparison.models[v].brier));
  assert.ok(Number.isFinite(report.overall.comparison.models[v].logLoss));
  const interval=report.overall.accuracy95[v];
  assert.ok(interval.lower>=0&&interval.upper<=1&&interval.lower<=interval.upper);
 }
 assert.equal(report.markets.firstHalf.status,'missing_pre_match_probabilities');
 assert.equal(report.markets.totalGoals.status,'missing_pre_match_probabilities');
});
test('small league segments and ambiguous chronological boundaries fail closed',()=>{
 const rows=Array.from({length:50},(_,i)=>fixture(i));
 rows[0].leagueId='single';
 const report=evaluateEvidenceReliability(rows);
 assert.equal(report.byLeague.single.status,'insufficient_verified_data');
 assert.equal(report.byLeague.single.comparison,null);
 for(const row of rows)row.date='2025-02-01T00:00:00Z';
 const ambiguous=evaluateEvidenceReliability(rows);
 assert.equal(ambiguous.status,'insufficient_chronological_holdout');
});
test('Wilson interval rejects invalid samples and stays bounded at extremes',()=>{
 assert.deepEqual(wilsonInterval(0,1).lower,0);
 assert.equal(wilsonInterval(1,1).upper,1);
 assert.throws(()=>wilsonInterval(2,1),/Invalid/);
 assert.throws(()=>wilsonInterval(0,0),/Invalid/);
});
