// Fail-closed point-in-time provenance check for offline model comparisons.
// Never claims a prediction is historical merely because a fixture is final.
const MODELS=['v1.2','v1.3','v1.4'];
export function auditPredictionProvenance(records,{requireAllModels=true}={}){
 if(!Array.isArray(records))throw new TypeError('Expected records array');
 const accepted=[],rejected=[],seen=new Set();
 for(const r of records){
  const id=r?.fixtureId;
  let reason=null;
  if(typeof id!=='string'||!id.trim())reason='missing_fixture_id';
  else if(seen.has(id))reason='duplicate_fixture_id';
  else seen.add(id);
  const kickoff=Date.parse(r?.date);
  if(!reason&&(!Number.isFinite(kickoff)||!/^\d{4}-\d{2}-\d{2}T/.test(r.date)))reason='invalid_kickoff';
  if(!reason&&(r.identity_verified!==true||r.score_verified!==true))reason='unverified_result';
  const modelNames=requireAllModels?MODELS:Object.keys(r.models??{});
  if(!reason&&(!modelNames.length||modelNames.some(name=>{
   const p=r.models?.[name],stamp=Date.parse(p?.predictedAt);
   return !p||typeof p.predictedAt!=='string'||!Number.isFinite(stamp)||stamp>=kickoff||stamp<0;
  })))reason='missing_or_late_prediction_evidence';
  if(reason)rejected.push({fixtureId:id??null,reason});
  else accepted.push(r);
 }
 return {accepted,rejected,acceptedCount:accepted.length,rejectedCount:rejected.length};
}
