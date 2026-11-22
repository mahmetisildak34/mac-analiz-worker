// Offline-only operational report. Accepts a local JSON array, never accesses D1 or providers.
import {readFile} from 'node:fs/promises';
import {summarizeFixtureHealth} from './fixture-health-readonly.mjs';
import {planFixtureChecks} from './fixture-check-planner.mjs';
export function buildFixtureOperationsReport(rows,{nowMs=Date.now(),maxChecks=20,minRetryMs=300000}={}){
 const health=summarizeFixtureHealth(rows,{nowMs});
 const plan=planFixtureChecks(rows,{nowMs,maxChecks,minRetryMs});
 return {mode:'offline-read-only',generatedAt:new Date(nowMs).toISOString(),health,checkPlan:plan,providerRequests:0,productionWrites:0,defaultModel:'v1.2'};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const path=process.argv[2];
 if(!path)throw new Error('Local fixture JSON path required');
 const rows=JSON.parse(await readFile(path,'utf8'));
 console.log(JSON.stringify(buildFixtureOperationsReport(rows),null,2));
}
