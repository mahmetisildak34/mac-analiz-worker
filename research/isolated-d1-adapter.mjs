// D1-compatible isolated adapter: dependency-injected DB only, never imports bindings.
// SQL schema: isolated-d1-schema.sql. All writes use INSERT (no UPSERT/REPLACE).
import {createHash} from 'node:crypto';
import {createPredictionLedger,pairPredictionWithVerifiedResult} from './isolated-prediction-ledger.mjs';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const versions=['v1.2','v1.3','v1.4'];
const parse=(json,expectedHash)=>{
 let row;
 try{row=JSON.parse(json);}catch{throw new Error('Corrupted stored JSON');}
 if(!row||hash((({sha256,...payload})=>payload)(row))!==expectedHash||row.sha256!==expectedHash)
  throw new Error('Stored evidence integrity mismatch');
 return row;
};
export function createIsolatedD1Store({db,now=()=>new Date().toISOString()}={}){
 if(!db||typeof db.prepare!=='function')throw new TypeError('Explicit isolated D1 binding required');
 const statement=(sql,...values)=>db.prepare(sql).bind(...values);
 async function read(id){
  if(typeof id!=='string'||!id)throw new TypeError('Fixture identity required');
  const row=await statement('SELECT fixture_id,league_id,kickoff,recorded_at,payload_json,sha256 FROM isolated_prediction_evidence WHERE fixture_id=?',id).first();
  if(!row)return null;
  const saved=parse(row.payload_json,row.sha256);
  if(saved.fixtureId!==id||row.fixture_id!==id||row.league_id!==saved.leagueId||row.kickoff!==saved.kickoff||row.recorded_at!==saved.recordedAt||!versions.every(v=>saved.models?.[v]?.predictedAt===saved.recordedAt))
   throw new Error('Stored prediction provenance mismatch');
  return structuredClone(saved);
 }
 async function append(input){
  const saved=createPredictionLedger({now}).append(input);
  try{
   await statement('INSERT INTO isolated_prediction_evidence (fixture_id,league_id,kickoff,recorded_at,sha256,payload_json) VALUES (?,?,?,?,?,?)',
    saved.fixtureId,saved.leagueId,saved.kickoff,saved.recordedAt,saved.sha256,JSON.stringify(saved)).run();
  }catch(e){if(/UNIQUE|PRIMARY KEY|constraint failed/i.test(String(e)))throw new Error('Immutable prediction already exists');throw e;}
  return structuredClone(saved);
 }
 async function saveVerifiedResult(id,result,{verifiedAt=now(),evidenceId}={}){
  if(typeof evidenceId!=='string'||!evidenceId.trim()||typeof verifiedAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(verifiedAt)||!Number.isFinite(Date.parse(verifiedAt)))
   throw new Error('Verified result provenance required');
  const saved=await read(id);
  if(!saved)throw new Error('Missing prediction evidence');
  const paired=pairPredictionWithVerifiedResult({
   get:key=>key===id?saved:null,
   verify:record=>record.sha256===hash((({sha256,...payload})=>payload)(record))
  },id,result);
  if(Date.parse(verifiedAt)<Date.parse(saved.kickoff))throw new Error('Result verified before kickoff');
  const payload={fixtureId:id,leagueId:saved.leagueId,homeTeamId:saved.homeTeamId,awayTeamId:saved.awayTeamId,
   date:saved.kickoff,homeGoals:paired.homeGoals,awayGoals:paired.awayGoals,
   identity_verified:true,score_verified:true,verifiedAt,evidenceId,predictionEvidenceSha256:saved.sha256};
  const sha256=hash(payload),record={...payload,sha256};
  try{
   await statement('INSERT INTO isolated_verified_results (fixture_id,verified_at,evidence_id,sha256,payload_json) VALUES (?,?,?,?,?)',
    id,verifiedAt,evidenceId,sha256,JSON.stringify(record)).run();
  }catch(e){if(/UNIQUE|PRIMARY KEY|constraint failed/i.test(String(e)))throw new Error('Immutable verified result already exists');throw e;}
  return structuredClone(record);
 }
 async function readVerifiedResult(id){
  const row=await statement('SELECT fixture_id,verified_at,evidence_id,payload_json,sha256 FROM isolated_verified_results WHERE fixture_id=?',id).first();
  if(!row)return null;
  const saved=parse(row.payload_json,row.sha256);
  if(saved.fixtureId!==id||row.fixture_id!==id||row.verified_at!==saved.verifiedAt||row.evidence_id!==saved.evidenceId)throw new Error('Stored result identity mismatch');
  return structuredClone(saved);
 }
 async function pair(id){
  const [prediction,result]=await Promise.all([read(id),readVerifiedResult(id)]);
  if(!prediction||!result)throw new Error('Missing prediction or verified result');
  if(result.predictionEvidenceSha256!==prediction.sha256||Date.parse(result.verifiedAt)<Date.parse(prediction.kickoff))throw new Error('Prediction evidence link mismatch');
  return pairPredictionWithVerifiedResult({
   get:key=>key===id?prediction:null,
   verify:record=>record.sha256===hash((({sha256,...payload})=>payload)(record))
  },id,result);
 }
 return {append,read,saveVerifiedResult,readVerifiedResult,pair};
}
