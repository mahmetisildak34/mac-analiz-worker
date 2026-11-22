import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {capturePublicEspn} from './capture-public-espn.mjs';
const capturedAt='2026-11-22T12:00:00Z';
test('real capture pipeline writes raw bytes, hash and accepted pre-match identities',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'espn-capture-'));
 try{
  const payload={events:[{id:'401',date:'2026-11-23T12:00:00Z',status:{type:{state:'pre',completed:false,name:'STATUS_SCHEDULED'}},competitions:[{competitors:[{homeAway:'home',team:{id:'11'}},{homeAway:'away',team:{id:'22'}}]}]}]};
  const fetcher=async()=>({ok:true,arrayBuffer:async()=>Buffer.from(JSON.stringify(payload))});
  const report=await capturePublicEspn({fetcher,outDir:dir,now:()=>capturedAt});
  assert.equal(Object.keys(report.leagues).length,6);
  for(const [league,result] of Object.entries(report.leagues)){
   assert.equal(result.status,'captured');assert.equal(result.eligible,1);assert.equal(result.accepted[0].fixtureId,'401');
   assert.equal(result.capturedAt,capturedAt);
   assert.equal(JSON.parse(await readFile(join(dir,result.file),'utf8')).events.length,1);
   assert.match(result.sha256,/^[a-f0-9]{64}$/);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
