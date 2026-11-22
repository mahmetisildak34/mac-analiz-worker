// Isolated, offline point-in-time prediction ledger. No D1 or provider bindings.
// The append-only interface can be backed by a separate isolated storage adapter.
import {createHash} from 'node:crypto';
const VERSIONS=['v1.2','v1.3','v1.4'];
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value.slice(0,10)?Date.parse(value):NaN;
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createPredictionLedger({now=()=>new Date().toISOString()}={}){
 if(typeof now!=='function')throw new TypeError('Clock required');
 const entries=new Map();
 function append({fixtureId,leagueId,homeTeamId,awayTeamId,kickoff,models,featureSnapshotId,featureAvailableAt,sourceEvidenceId}){
  const recordedAt=now(),recordedMs=timestamp(recordedAt),kickoffMs=timestamp(kickoff),featureMs=timestamp(featureAvailableAt);
  if(![fixtureId,leagueId,homeTeamId,awayTeamId,featureSnapshotId,sourceEvidenceId].every(validId))throw new Error('Missing or invalid immutable identity');
  if(homeTeamId===awayTeamId)throw new Error('Same team on both sides');
  if(!Number.isFinite(recordedMs)||!Number.isFinite(kickoffMs)||!Number.isFinite(featureMs)||recordedMs>=kickoffMs||featureMs>recordedMs)throw new Error('Late or unproven pre-match snapshot');
  if(!models||Object.keys(models).length!==3||!VERSIONS.every(v=>Object.hasOwn(models,v)))throw new Error('All three model versions required');
  const validated={};
  for(const v of VERSIONS){
   const p=models[v];
   if(!p||!['home','draw','away'].every(k=>typeof p[k]==='number'&&Number.isFinite(p[k])&&p[k]>=0&&p[k]<=1)||Math.abs(p.home+p.draw+p.away-1)>1e-8||!validId(p.codeVersion))throw new Error('Invalid model probabilities or code version');
   validated[v]={home:p.home,draw:p.draw,away:p.away,codeVersion:p.codeVersion,predictedAt:recordedAt};
  }
  if(entries.has(fixtureId))throw new Error('Immutable prediction already exists');
  const record={fixtureId,leagueId,homeTeamId,awayTeamId,kickoff,date:kickoff,recordedAt,featureSnapshotId,featureAvailableAt,sourceEvidenceId,models:validated};
  const frozen=structuredClone({...record,sha256:digest(record)});
  entries.set(fixtureId,frozen);
  return structuredClone(frozen);
 }
 function get(fixtureId){const r=entries.get(fixtureId);return r?structuredClone(r):null;}
 function list(){return [...entries.values()].map(entry=>structuredClone(entry));}
 function verify(record){if(!record||typeof record!=='object')return false;const {sha256,...payload}=record;return typeof sha256==='string'&&sha256===digest(payload);}
 return {append,get,list,verify,size:()=>entries.size};
}

/**
 * Join an immutable pre-kickoff prediction with a separately verified final result.
 * Fail closed on missing source identity, mismatched teams or invalid ledger digest.
 * The result must be independently verified; the ledger never infers a final score.
 */
export function pairPredictionWithVerifiedResult(ledger,fixtureId,result){
 const saved=ledger.get(fixtureId);
 if(!saved||!ledger.verify(saved))throw new Error('Missing or invalid prediction evidence');
 if(!result||result.identity_verified!==true||result.score_verified!==true||
    result.fixtureId!==saved.fixtureId||result.leagueId!==saved.leagueId||
    result.homeTeamId!==saved.homeTeamId||result.awayTeamId!==saved.awayTeamId||
    result.date!==saved.kickoff||
    !Number.isInteger(result.homeGoals)||result.homeGoals<0||
    !Number.isInteger(result.awayGoals)||result.awayGoals<0)
  throw new Error('Unverified or mismatched final result');
 return {fixtureId:saved.fixtureId,date:saved.kickoff,leagueId:saved.leagueId,
  identity_verified:true,score_verified:true,homeGoals:result.homeGoals,
  awayGoals:result.awayGoals,models:structuredClone(saved.models),
  predictionEvidenceSha256:saved.sha256,featureSnapshotId:saved.featureSnapshotId,
  sourceEvidenceId:saved.sourceEvidenceId};
}
