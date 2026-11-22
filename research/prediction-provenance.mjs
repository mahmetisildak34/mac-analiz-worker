// Fail-closed point-in-time provenance check for offline model comparisons.
// Never claims a prediction is historical merely because a fixture is final.
const MODELS=['v1.2','v1.3','v1.4'];
function parseUnambiguousTimestamp(value){
 if(typeof value!=='string'||!/^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,3})?(?:Z|[+-](?:0\\d|1[0-4]):[0-5]\\d)$/.test(value))return NaN;
 // Date.parse normalizes impossible calendar days; reject those before accepting evidence.
 const day=value.slice(0,10),calendar=new Date(day+'T00:00:00Z');
 if(!Number.isFinite(calendar.getTime())||calendar.toISOString().slice(0,10)!==day)return NaN;
 const offset=value.slice(-6);
 if(offset[0]!=='Z'&&offset.slice(1,3)==='14'&&offset.slice(4)!=='00')return NaN;
 return Date.parse(value);
}
export function auditPredictionProvenance(records,{requireAllModels=true}={}){
 if(!Array.isArray(records))throw new TypeError('Expected records array');
 const accepted=[],rejected=[],seen=new Set();
 for(const r of records){
  const id=r?.fixtureId;
  let reason=null;
  if(typeof id!=='string'||!id.trim())reason='missing_fixture_id';
  else if(seen.has(id))reason='duplicate_fixture_id';
  else seen.add(id);
  const kickoff=parseUnambiguousTimestamp(r?.date);
  if(!reason&&(!Number.isFinite(kickoff)||!/^\d{4}-\d{2}-\d{2}T/.test(r.date)))reason='invalid_kickoff';
  if(!reason&&(r.identity_verified!==true||r.score_verified!==true))reason='unverified_result';
  const modelNames=requireAllModels?MODELS:Object.keys(r.models??{});
  if(!reason&&(!modelNames.length||modelNames.some(name=>{
   const p=r.models?.[name],stamp=parseUnambiguousTimestamp(p?.predictedAt);
   return !p||typeof p.predictedAt!=='string'||!Number.isFinite(stamp)||stamp>=kickoff||stamp<0;
  })))reason='missing_or_late_prediction_evidence';
  if(reason)rejected.push({fixtureId:id??null,reason});
  else accepted.push(r);
 }
 return {accepted,rejected,acceptedCount:accepted.length,rejectedCount:rejected.length};
}
