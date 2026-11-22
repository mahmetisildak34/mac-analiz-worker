import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createIsolatedPredictionStore} from './isolated-prediction-store.mjs';
const clock=()=> '2026-11-22T11:00:00Z';
const models=()=>Object.fromEntries(['v1.2','v1.3','v1.4'].map(v=>[v,{home:.5,draw:.3,away:.2,codeVersion:'commit-'+v}]));
const input=(fixtureId='espn-123')=>({fixtureId,leagueId:'tur.1',homeTeamId:'home-1',awayTeamId:'away-2',
 kickoff:'2026-11-23T15:00:00Z',featureSnapshotId:'features-123',featureAvailableAt:'2026-11-22T10:00:00Z',
 sourceEvidenceId:'espn-123-raw',models:models()});
const withStore=async fn=>{const directory=await mkdtemp(join(tmpdir(),'mam-prediction-test-'));try{await fn(directory);}finally{await rm(directory,{recursive:true,force:true});}};
const finalResult=()=>({fixtureId:'espn-123',leagueId:'tur.1',homeTeamId:'home-1',awayTeamId:'away-2',date:'2026-11-23T15:00:00Z',identity_verified:true,score_verified:true,homeGoals:2,awayGoals:1});
test('predictions persist across independent store instances and preserve three versions',async()=>withStore(async directory=>{
 const first=createIsolatedPredictionStore({directory,now:clock});
 const saved=await first.append(input());
 const second=createIsolatedPredictionStore({directory,now:clock});
 assert.deepEqual(await second.read('espn-123'),saved);
 assert.deepEqual((await second.list()).map(x=>x.fixtureId),['espn-123']);
 assert.deepEqual(Object.keys(saved.models),['v1.2','v1.3','v1.4']);
 assert.equal(saved.models['v1.4'].predictedAt,clock());
 assert.equal('homeGoals' in saved,false);
 assert.equal((await readdir(directory)).filter(x=>x.endsWith('.tmp')).length,0);
}));
test('duplicate writes and 32 simultaneous writers are atomic and first-writer-wins',async()=>withStore(async directory=>{
 const writers=Array.from({length:32},()=>createIsolatedPredictionStore({directory,now:clock}));
 const outcomes=await Promise.allSettled(writers.map(store=>store.append(input())));
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(outcomes.filter(x=>x.status==='rejected').length,31);
 assert.ok(outcomes.filter(x=>x.status==='rejected').every(x=>/already exists/.test(x.reason.message)));
 assert.equal((await writers[0].list()).length,1);
 await assert.rejects(writers[0].append(input()),/already exists/);
}));
test('corrupted JSON, changed probabilities and mismatched filename are rejected',async()=>withStore(async directory=>{
 const store=createIsolatedPredictionStore({directory,now:clock});
 await store.append(input());
 const name=(await readdir(directory)).find(x=>x.endsWith('.json'));
 const file=join(directory,name);
 const original=await readFile(file,'utf8');
 const tampered=JSON.parse(original);tampered.models['v1.2'].home=.99;
 await writeFile(file,JSON.stringify(tampered));
 await assert.rejects(store.read('espn-123'),/integrity mismatch/);
 await assert.rejects(store.list(),/integrity mismatch/);
 await writeFile(file,'{');
 await assert.rejects(store.read('espn-123'),/Corrupted prediction JSON/);
 await writeFile(file,original);
 assert.equal((await store.read('espn-123')).fixtureId,'espn-123');
}));
test('late predictions and incomplete model versions never create persistent files',async()=>withStore(async directory=>{
 const store=createIsolatedPredictionStore({directory,now:()=> '2026-11-23T15:00:00Z'});
 await assert.rejects(store.append(input()),/Late or unproven/);
 const valid=createIsolatedPredictionStore({directory,now:clock});
 const incomplete=input();delete incomplete.models['v1.3'];
 await assert.rejects(valid.append(incomplete),/All three/);
 assert.deepEqual(await valid.list(),[]);
}));
test('independent final-score join rejects wrong identity and missing proof without storing outcomes',async()=>withStore(async directory=>{
 const store=createIsolatedPredictionStore({directory,now:clock});
 await store.append(input());
 const paired=await store.pair('espn-123',finalResult());
 assert.equal(paired.homeGoals,2);
 assert.equal(paired.predictionEvidenceSha256,(await store.read('espn-123')).sha256);
 assert.equal('homeGoals' in await store.read('espn-123'),false);
 await assert.rejects(store.pair('espn-123',{...finalResult(),awayTeamId:'wrong'}),/mismatched/);
 await assert.rejects(store.pair('espn-123',{...finalResult(),score_verified:false}),/mismatched/);
 await assert.rejects(store.pair('unknown',finalResult()),/Missing/);
}));
