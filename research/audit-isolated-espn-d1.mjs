// Read-only audit for the dedicated isolated D1; never writes or queries production/preview.
import {validateEvidenceRow} from './ingest-espn-statistics-d1.mjs';
const ACCOUNT='640bfb6a538ee57864281941b14dbc55';
const DATABASE='fb9b42cc-8d96-4911-b193-0983527ee593';
const URL='https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT+'/d1/database/'+DATABASE+'/query';
const SQL="SELECT source,fixture_id,kickoff,status,home_team_id,away_team_id,home_team,away_team,home_goals,away_goals,statistics_json,raw_json FROM matches WHERE source='ESPN' ORDER BY fixture_id LIMIT 500";
export async function auditIsolatedEvidence({token,fetcher=fetch}={}){
 if(typeof token!=='string'||!token)throw new Error('Dedicated isolated D1 token required');
 const response=await fetcher(URL,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({sql:SQL,params:[]})});
 const body=await response.json();
 if(!response.ok||!body.success||!Array.isArray(body.result?.[0]?.results))throw new Error('Isolated D1 read-only query failed');
 const rows=body.result[0].results,seen=new Set(),leagues={};
 const errors=[];
 for(const row of rows){
  try{
   if(seen.has(row.fixture_id))throw new Error('Duplicate fixture');
   seen.add(row.fixture_id);
   const stats=JSON.parse(row.statistics_json);
   const record={...row,home_team_id:Number(row.home_team_id),away_team_id:Number(row.away_team_id),home_goals:Number(row.home_goals),away_goals:Number(row.away_goals),raw_sha256:stats.rawSha256};
   const verified=validateEvidenceRow(record);
   leagues[verified.leagueId]=(leagues[verified.leagueId]??0)+1;
  }catch(error){errors.push({fixtureId:String(row.fixture_id??''),reason:String(error.message)});}
 }
 return {database:'mam-statistics-isolated-test',mode:'read-only',checked:rows.length,valid:rows.length-errors.length,invalid:errors.length,leagues,errors,limit:500,truncated:rows.length===500,passed:errors.length===0&&rows.length>0&&rows.length<500};
}
if(process.argv[1]&&import.meta.url===new URL('file://'+process.argv[1]).href){
 const result=await auditIsolatedEvidence({token:process.env.CLOUDFLARE_ISOLATED_D1_TOKEN});
 console.log(JSON.stringify(result,null,2));
 if(!result.passed)process.exitCode=1;
}
