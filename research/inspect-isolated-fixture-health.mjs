// Read-only operational inspection of the dedicated isolated D1. No provider requests or writes.
import {buildFixtureOperationsReport} from './fixture-operations-report.mjs';
const ACCOUNT='640bfb6a538ee57864281941b14dbc55';
const DATABASE='fb9b42cc-8d96-4911-b193-0983527ee593';
const ENDPOINT='https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT+'/d1/database/'+DATABASE+'/query';
const SQL="SELECT fixture_id,source,status,kickoff,home_goals,away_goals,statistics_json FROM matches WHERE source='ESPN' ORDER BY fixture_id LIMIT 500";
export async function inspectIsolatedFixtureHealth({token,fetcher=fetch,nowMs=Date.now()}={}){
 if(typeof token!=='string'||!token)throw new Error('Dedicated isolated D1 token required');
 const response=await fetcher(ENDPOINT,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({sql:SQL,params:[]})});
 const payload=await response.json();
 if(!response.ok||payload.success!==true||!Array.isArray(payload.result?.[0]?.results))throw new Error('Isolated D1 read-only inspection failed');
 const rows=payload.result[0].results;
 if(rows.length===500)throw new Error('Inspection reached row cap; cannot claim complete coverage');
 const report=buildFixtureOperationsReport(rows,{nowMs});
 return {...report,database:'mam-statistics-isolated-test',coverageComplete:true,queryRows:rows.length};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const result=await inspectIsolatedFixtureHealth({token:process.env.CLOUDFLARE_ISOLATED_D1_TOKEN});
 console.log(JSON.stringify(result,null,2));
}
