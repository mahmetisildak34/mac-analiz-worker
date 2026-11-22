// Local, isolated, durable research storage. No D1/Worker bindings or provider calls.
// Each fixture is an atomic create-only JSON file. SHA-256 detects accidental mutation;
// this is NOT a trusted timestamp authority or tamper-proof storage against a writer
// with filesystem access. Export signed evidence externally for stronger guarantees.
import {mkdir,open,readFile,link,unlink,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createPredictionLedger,pairPredictionWithVerifiedResult} from './isolated-prediction-ledger.mjs';
const fileName=id=>createHash('sha256').update(id).digest('hex')+'.json';
export function createIsolatedPredictionStore({directory,now}={}){
 if(typeof directory!=='string'||!directory.trim())throw new TypeError('Isolated directory required');
 const root=resolve(directory);
 const filename=id=>join(root,fileName(id));
 const check=record=>{
  if(!record||typeof record.fixtureId!=='string'||!record.fixtureId||!record.sha256)
   throw new Error('Invalid persisted prediction');
  const {sha256,...payload}=record;
  const digest=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  if(digest!==sha256)throw new Error('Prediction integrity mismatch');
  if(!record.models||!['v1.2','v1.3','v1.4'].every(v=>record.models[v]?.predictedAt===record.recordedAt))
   throw new Error('Invalid paired model provenance');
  return record;
 };
 async function read(id){
  if(typeof id!=='string'||!id)throw new TypeError('Fixture ID required');
  let data;
  try{data=await readFile(filename(id),'utf8');}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
  let record;
  try{record=JSON.parse(data);}catch{throw new Error('Corrupted prediction JSON');}
  check(record);
  if(record.fixtureId!==id)throw new Error('Fixture identity mismatch');
  return structuredClone(record);
 }
 async function append(input){
  // Validate all three predictions and pre-kickoff feature timestamps before I/O.
  const record=createPredictionLedger({now}).append(input);
  await mkdir(root,{recursive:true});
  const temporary=join(root,'.'+randomUUID()+'.tmp');
  let handle;
  try{
   handle=await open(temporary,'wx',0o600);
   await handle.writeFile(JSON.stringify(record)+'\n','utf8');
   await handle.sync();
   await handle.close();handle=null;
   // link() is atomic and fails with EEXIST if another writer won the race.
   await link(temporary,filename(record.fixtureId));
   // Sync directory metadata so the newly linked entry survives process restart.
   const dir=await open(root,'r');
   try{await dir.sync();}finally{await dir.close();}
   return structuredClone(record);
  }catch(error){
   if(error.code==='EEXIST')throw new Error('Immutable prediction already exists');
   throw error;
  }finally{
   if(handle)await handle.close();
   await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});
  }
 }
 async function list(){
  let names;
  try{names=await readdir(root);}catch(e){if(e.code==='ENOENT')return [];throw e;}
  const records=[];
  for(const name of names.filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).sort()){
   let record;
   try{record=JSON.parse(await readFile(join(root,name),'utf8'));}catch{throw new Error('Corrupted prediction JSON');}
   check(record);
   if(fileName(record.fixtureId)!==name)throw new Error('Fixture filename mismatch');
   records.push(structuredClone(record));
  }
  return records;
 }
 async function pair(id,result){
  const saved=await read(id);
  if(!saved)throw new Error('Missing prediction evidence');
  // Existing independent score verifier requires only get() and verify().
  return pairPredictionWithVerifiedResult({
   get:key=>key===id?structuredClone(saved):null,
   verify:record=>{try{return !!check(record);}catch{return false;}}
  },id,result);
 }
 return {append,read,list,pair,directory:root};
}
