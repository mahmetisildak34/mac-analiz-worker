// Offline scheduling decisions only. Never fetches providers or changes D1.
import {classifyFixtureHealth} from './fixture-health-readonly.mjs';
export function planFixtureChecks(rows,{nowMs=Date.now(),maxChecks=20,minRetryMs=5*60*1000}={}){
 if(!Array.isArray(rows)||!Number.isFinite(nowMs)||!Number.isSafeInteger(maxChecks)||maxChecks<0||!Number.isFinite(minRetryMs)||minRetryMs<=0)throw new TypeError('Invalid check planning options');
 const planned=[],skipped=[],seen=new Set();
 for(const row of rows){
  const health=classifyFixtureHealth(row,{nowMs});
  const id=health.fixtureId;
  if(!id||seen.has(id)){skipped.push({fixtureId:id,reason:'missing_or_duplicate_identity'});continue;}
  seen.add(id);
  const last=Date.parse(row.lastCheckedAt??'');
  if(Number.isFinite(last)&&nowMs-last<minRetryMs){skipped.push({fixtureId:id,reason:'retry_cooldown'});continue;}
  if(!health.requiresProviderCheck){skipped.push({fixtureId:id,reason:'no_health_issue'});continue;}
  const reason=health.issues;
  // Only plan safe read-only checks. The caller must separately authorize a provider.
  planned.push({fixtureId:id,source:row.source,priority:health.priority,reason});
 }
 const rank={error:0,review:1,ok:2};
 planned.sort((a,b)=>rank[a.priority]-rank[b.priority]||a.fixtureId.localeCompare(b.fixtureId));
 return {mode:'plan-only',providerRequests:0,selected:planned.slice(0,maxChecks),deferred:planned.slice(maxChecks),skipped};
}
