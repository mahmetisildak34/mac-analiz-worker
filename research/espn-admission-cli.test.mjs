import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectCapturedScoreboards} from './espn-admission-cli.mjs';
const capturedAt='2026-11-22T10:00:00Z',kickoff='2026-12-01T18:00:00Z';
const fixture=id=>({id,date:kickoff,status:{type:{state:'pre',completed:false,name:'STATUS_SCHEDULED'}},competitions:[{competitors:[{homeAway:'home',team:{id:'1'}},{homeAway:'away',team:{id:'2'}}]}]});
test('offline capture manifest admits two leagues but never invents predictions',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'espn-admission-'));
 try{
  await writeFile(join(dir,'tur.json'),JSON.stringify({leagues:[{slug:'tur.1'}],events:[fixture('100')]}));
  await writeFile(join(dir,'eng.json'),JSON.stringify({leagues:[{slug:'eng.1'}],events:[fixture('200')]}));
  const manifest={capturedAt,leagues:[{leagueId:'tur.1',scoreboardFile:'tur.json'},{leagueId:'eng.1',scoreboardFile:'eng.json'}]};
  await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));
  const report=await inspectCapturedScoreboards(join(dir,'manifest.json'),{now:capturedAt});
  assert.equal(report.leagues['tur.1'].eligible,1);
  assert.equal(report.leagues['eng.1'].eligible,1);
  assert.equal(report.realPredictionCount,0);
  assert.equal(report.evidence.length,2);
  assert.equal(report.evidence[0].leagueId,'tur.1');
  assert.match(report.evidence[0].scoreboardSha256,/^[a-f0-9]{64}$/);
  assert.notEqual(report.evidence[0].scoreboardSha256,report.evidence[1].scoreboardSha256);
  manifest.leagues[0].expectedSha256=report.evidence[0].scoreboardSha256;
  await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));
  assert.equal((await inspectCapturedScoreboards(join(dir,'manifest.json'),{now:capturedAt})).leagues['tur.1'].eligible,1);
  manifest.leagues[0].expectedSha256='0'.repeat(64);
  await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(inspectCapturedScoreboards(join(dir,'manifest.json'),{now:capturedAt}),/digest mismatch/);
  delete manifest.leagues[0].expectedSha256;
  await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));
  assert.equal(report.modelComparison.status,'insufficient_verified_pre_match_predictions');
  await writeFile(join(dir,'eng.json'),JSON.stringify({leagues:[{slug:'eng.1'}],events:[fixture('100')]}));
  await assert.rejects(inspectCapturedScoreboards(join(dir,'manifest.json'),{now:capturedAt}),/Cross-league fixture identity collision/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('offline capture manifest rejects missing evidence instead of guessing',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'espn-admission-'));
 try{
  await writeFile(join(dir,'manifest.json'),JSON.stringify({capturedAt,leagues:[{leagueId:'tur.1',scoreboardFile:'missing.json'}]}));
  await assert.rejects(inspectCapturedScoreboards(join(dir,'manifest.json'),{now:capturedAt}),/ENOENT/);
  await writeFile(join(dir,'manifest.json'),JSON.stringify({capturedAt,leagues:[]}));
  await assert.rejects(inspectCapturedScoreboards(join(dir,'manifest.json'),{now:capturedAt}),/Nonempty/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
