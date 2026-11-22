import test from 'node:test';
import assert from 'node:assert/strict';
import {createPredictionLedger} from './isolated-prediction-ledger.mjs';
const versions=()=>Object.fromEntries(['v1.2','v1.3','v1.4'].map(v=>[v,{home:.5,draw:.3,away:.2,codeVersion:'sha-'+v}]));
const row=()=>({fixtureId:'espn-1',leagueId:'tur.1',homeTeamId:'team-1',awayTeamId:'team-2',kickoff:'2026-11-23T15:00:00Z',featureSnapshotId:'snapshot-1',featureAvailableAt:'2026-11-22T10:00:00Z',sourceEvidenceId:'espn-proof-1',models:versions()});
const clock=()=> '2026-11-22T11:00:00Z';
test('three-version predictions have immutable snapshot identity, version, timestamp and integrity digest',()=>{
 const ledger=createPredictionLedger({now:clock});
 const saved=ledger.append(row());
 assert.equal(saved.models['v1.2'].predictedAt,clock());
 assert.equal(saved.models['v1.4'].codeVersion,'sha-v1.4');
 assert.equal(ledger.verify(saved),true);
 saved.models['v1.2'].home=0;
 assert.equal(ledger.get('espn-1').models['v1.2'].home,.5);
 assert.equal(ledger.verify(saved),false);
 assert.equal(ledger.size(),1);
 assert.throws(()=>ledger.append(row()),/already exists/);
});
test('late recording and post-recording feature snapshots are refused',()=>{
 for(const at of ['2026-11-23T15:00:00Z','2026-11-23T15:01:00Z']){
  const ledger=createPredictionLedger({now:()=>at});
  assert.throws(()=>ledger.append(row()),/Late or unproven/);
 }
 const ledger=createPredictionLedger({now:clock});
 assert.throws(()=>ledger.append({...row(),featureAvailableAt:'2026-11-22T12:00:00Z'}),/Late or unproven/);
});
test('missing version, invalid probabilities, invalid identity and source proof fail closed',()=>{
 const ledger=createPredictionLedger({now:clock});
 const missing=versions();delete missing['v1.4'];
 assert.throws(()=>ledger.append({...row(),models:missing}),/All three/);
 const bad=versions();bad['v1.3'].draw=.9;
 assert.throws(()=>ledger.append({...row(),models:bad}),/Invalid model/);
 assert.throws(()=>ledger.append({...row(),awayTeamId:'team-1'}),/Same team/);
 assert.throws(()=>ledger.append({...row(),sourceEvidenceId:''}),/identity/);
 assert.equal(ledger.size(),0);
});
test('same-fixture versions are paired and ledger never accepts result scores',()=>{
 const ledger=createPredictionLedger({now:clock});
 const saved=ledger.append({...row(),homeGoals:8,awayGoals:0});
 assert.equal('homeGoals' in saved,false);
 assert.deepEqual(Object.keys(saved.models),['v1.2','v1.3','v1.4']);
 assert.equal(ledger.list().length,1);
});
