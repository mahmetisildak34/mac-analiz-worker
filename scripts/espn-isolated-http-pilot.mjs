import fs from "node:fs";
import {verifyEspnScoreboard,makeIsolatedInsert} from "../espn-isolated-acceptance.mjs";
const league="eng.1", day="20261121";
const url=`https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard?dates=${day}`;
const output="espn-pilot-output";
fs.mkdirSync(output,{recursive:true});
const report={requested_url:url,attempts:0,http_status:null,accepted:0,score_verified:0,identity_verified:0,error:null,mode:"read_only_one_request"};
const save=()=>fs.writeFileSync(output+"/report.json",JSON.stringify(report,null,2));
try {
  report.attempts=1;
  const response=await fetch(url,{signal:AbortSignal.timeout(12000),headers:{"accept":"application/json","user-agent":"MaçAnalizMerkezi-IsolatedAcceptance/1.0"}});
  report.http_status=response.status;
  if(!response.ok) throw Error("ESPN HTTP "+response.status);
  const payload=await response.json();
  const matches=verifyEspnScoreboard(payload,league,day,10);
  report.accepted=matches.length;
  report.identity_verified=matches.filter(x=>x.identity_verified===1).length;
  report.score_verified=matches.filter(x=>x.score_verified===1).length;
  const sql=matches.map(m=>makeIsolatedInsert(m));
  // Only prepared, bound parameter objects: no D1 access or SQL execution in GitHub Actions.
  fs.writeFileSync(output+"/verified-matches.json",JSON.stringify(matches,null,2));
  fs.writeFileSync(output+"/isolated-inserts.json",JSON.stringify(sql,null,2));
  const keys=new Set(matches.map(m=>m.fixture_id));
  if(keys.size!==matches.length || sql.some(x=>!x.sql.startsWith("INSERT INTO mam_archive_test_matches "))) throw Error("isolation or duplicate guard failure");
} catch(e) {report.error=String(e?.message||e);process.exitCode=1}
finally {save();console.log(JSON.stringify(report))}
