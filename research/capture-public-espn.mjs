// Fetch actual public ESPN scoreboards read-only and preserve raw SHA-256 evidence.
// This is fixture capture, NOT a Poisson prediction or independent score verification.
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {admitEspnScoreboard} from './espn-pre-match-admission.mjs';
const leagues=["eng.1","tur.1","esp.1","ger.1","ita.1","fra.1","uefa.champions","uefa.europa","ned.1","por.1","uefa.europa.conf","eng.2","eng.fa","eng.league_cup","esp.2","esp.copa_del_rey","ger.2","ger.dfb_pokal","ita.2","ita.coppa_italia","fra.2","fra.coupe_de_france","bel.1","tur.2","sco.1","usa.1","bra.1","arg.1","mex.1","jpn.1","aus.1","chn.1","fifa.world","uefa.euro","uefa.nations","caf.nations","fifa.cwc","ksa.1"];
const sha=x=>createHash('sha256').update(x).digest('hex');
export async function capturePublicEspn({fetcher=fetch,outDir='espn-captures',now=()=>new Date().toISOString()}={}){
 await mkdir(outDir,{recursive:true});
 const report={startedAt:now(),source:'ESPN public scoreboard read-only',leagues:{}};
 for(const league of leagues){
  const url='https://site.api.espn.com/apis/site/v2/sports/soccer/'+league+'/scoreboard?limit=500';
  try{
   const response=await fetcher(url,{headers:{accept:'application/json'},signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw new Error('HTTP '+response.status);
   const raw=Buffer.from(await response.arrayBuffer());
   const capturedAt=now();
   if(raw.length>5_000_000)throw new Error('Payload too large');
   const data=JSON.parse(raw.toString('utf8'));
   if(!Array.isArray(data.events))throw new Error('Missing events');
   const filename=league.replaceAll('.','-')+'.json';
   await writeFile(resolve(outDir,filename),raw,{flag:'wx'});
   const admission=admitEspnScoreboard(data,{leagueId:league,capturedAt,now:capturedAt});
   report.leagues[league]={status:'captured',capturedAt,events:data.events.length,sha256:sha(raw),file:filename,eligible:admission.eligible,rejected:admission.rejected,accepted:admission.accepted};
  }catch(error){report.leagues[league]={status:'failed',reason:String(error.message).slice(0,150)};}
 }
 await writeFile(resolve(outDir,'manifest.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 return report;
}
if(process.argv[1]&&import.meta.url===new URL('file://'+resolve(process.argv[1])).href){
 const outDir=process.argv[2]??'espn-captures';
 const report=await capturePublicEspn({outDir});
 console.log(JSON.stringify(report,null,2));
 if(Object.values(report.leagues).some(x=>x.status!=='captured'))process.exitCode=1;
}
