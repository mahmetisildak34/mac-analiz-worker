import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createIsolatedD1Store} from './isolated-d1-adapter.mjs';
const schema=await readFile(fileURLToPath(new URL('./isolated-d1-schema.sql',import.meta.url)),'utf8');
const dbFactory=()=>{const raw=new DatabaseSync(':memory:');raw.exec('PRAGMA foreign_keys=ON');raw.exec(schema);
 return {raw,db:{prepare:sql=>({bind(...args){const stmt=raw.prepare(sql);return {first:async()=>stmt.get(...args)??null,run:async()=>stmt.run(...args)};}})}};};
const models=()=>Object.fromEntries(['v1.2','v1.3','v1.4'].map(v=>[v,{home:.5,draw:.3,away:.2,codeVersion:'commit-'+v}]));
const prediction=()=>({fixtureId:'espn-1',leagueId:'tur.1',homeTeamId:'home',awayTeamId:'away',
 kickoff:'2026-11-23T15:00:00Z',featureSnapshotId:'snapshot-1',featureAvailableAt:'2026-11-22T10:00:00Z',
 sourceEvidenceId:'espn-source-1',models:models()});
const result=()=>({fixtureId:'espn-1',leagueId:'tur.1',homeTeamId:'home',awayTeamId:'away',date:'2026-11-23T15:00:00Z',
 identity_verified:true,score_verified:true,homeGoals:2,awayGoals:1});
const early=()=> '2026-11-22T11:00:00Z';
const late=()=> '2026-11-24T11:00:00Z';
test('isolated SQLite/D1-compatible adapter persists three versions and independently verified results',async()=>{
 const {raw,db}=dbFactory();
 try{
  const writer=createIsolatedD1Store({db,now:early});
  const saved=await writer.append(prediction());
  const reader=createIsolatedD1Store({db,now:late});
  assert.deepEqual(await reader.read('espn-1'),saved);
  assert.equal(await reader.readVerifiedResult('espn-1'),null);
  await assert.rejects(reader.pair('espn-1'),/Missing/);
  const verified=await reader.saveVerifiedResult('espn-1',result(),{evidenceId:'espn-final-1'});
  assert.equal(verified.homeGoals,2);
  assert.equal((await reader.pair('espn-1')).models['v1.4'].codeVersion,'commit-v1.4');
  assert.equal('homeGoals' in await reader.read('espn-1'),false);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM isolated_prediction_evidence').get().n,1);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM isolated_verified_results').get().n,1);
 }finally{raw.close();}
});
test('duplicate and 24 concurrent writes allow only one winner',async()=>{
 const {raw,db}=dbFactory();
 try{
  const writers=Array.from({length:24},()=>createIsolatedD1Store({db,now:early}));
  const outcomes=await Promise.allSettled(writers.map(x=>x.append(prediction())));
  assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(outcomes.filter(x=>x.status==='rejected').length,23);
  assert.ok(outcomes.filter(x=>x.status==='rejected').every(x=>/already exists/.test(x.reason.message)));
 }finally{raw.close();}
});
test('database triggers forbid UPDATE and DELETE, and SHA-256 detects corrupted payloads',async()=>{
 const {raw,db}=dbFactory();
 try{
  const store=createIsolatedD1Store({db,now:early});
  await store.append(prediction());
  assert.throws(()=>raw.exec("UPDATE isolated_prediction_evidence SET recorded_at='fake'"),/immutable prediction/);
  assert.throws(()=>raw.exec('DELETE FROM isolated_prediction_evidence'),/immutable prediction/);
  raw.exec('DROP TRIGGER isolated_predictions_no_update');
  raw.exec("UPDATE isolated_prediction_evidence SET payload_json='{}'");
  await assert.rejects(store.read('espn-1'),/integrity mismatch/);
 }finally{raw.close();}
});
test('wrong fixture, missing score proof, late prediction and duplicate results are rejected',async()=>{
 const {raw,db}=dbFactory();
 try{
  const writer=createIsolatedD1Store({db,now:early});
  await writer.append(prediction());
  await assert.rejects(writer.append(prediction()),/already exists/);
  const verifier=createIsolatedD1Store({db,now:late});
  await assert.rejects(verifier.saveVerifiedResult('espn-1',{...result(),homeTeamId:'wrong'},{evidenceId:'source-1'}),/mismatched/);
  await assert.rejects(verifier.saveVerifiedResult('espn-1',{...result(),score_verified:false},{evidenceId:'source-1'}),/mismatched/);
  await assert.rejects(verifier.saveVerifiedResult('espn-1',result(),{evidenceId:''}),/provenance/);
  await verifier.saveVerifiedResult('espn-1',result(),{evidenceId:'source-1'});
  await assert.rejects(verifier.saveVerifiedResult('espn-1',result(),{evidenceId:'source-1'}),/already exists/);
  assert.throws(()=>raw.exec('DELETE FROM isolated_verified_results'),/immutable result/);
  await assert.rejects(verifier.append(prediction()),/Late or unproven/);
 }finally{raw.close();}
});
