// Offline CLI: admit independently captured ESPN scoreboards without fabricating predictions.
// Usage: node research/espn-admission-cli.mjs <manifest.json>
// Manifest: {capturedAt, leagues:[{leagueId, scoreboardFile}]}; scoreboardFile is a local JSON path.
// No network requests, D1 bindings or provider API calls.
import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {reportLeagueAdmissions} from './espn-pre-match-admission.mjs';
export async function inspectCapturedScoreboards(manifestPath,{now=new Date().toISOString()}={}){
 const absolute=resolve(manifestPath);
 const manifest=JSON.parse(await readFile(absolute,'utf8'));
 if(!manifest||!Array.isArray(manifest.leagues)||manifest.leagues.length===0)throw new Error('Nonempty league manifest required');
 if(typeof manifest.capturedAt!=='string')throw new Error('Capture timestamp required');
 const inputs=[];
 for(const league of manifest.leagues){
  if(typeof league?.scoreboardFile!=='string'||!league.scoreboardFile.trim())throw new Error('Local scoreboard file required');
  const path=resolve(dirname(absolute),league.scoreboardFile);
  const payload=JSON.parse(await readFile(path,'utf8'));
  inputs.push({leagueId:league.leagueId,capturedAt:manifest.capturedAt,payload});
 }
 const report=reportLeagueAdmissions(inputs,{now});
 return {...report,capturedAt:manifest.capturedAt,checkedAt:now,source:'local_raw_espn_scoreboard',
  note:'Fixture eligibility is not a recorded model prediction; model accuracy requires independent pre-kickoff evidence and verified results.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv.length!==3){console.error('Usage: node research/espn-admission-cli.mjs <manifest.json>');process.exitCode=2;}
 else inspectCapturedScoreboards(process.argv[2]).then(report=>console.log(JSON.stringify(report,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
