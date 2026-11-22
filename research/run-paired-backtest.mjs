// Offline paired evaluation of verified, precomputed predictions.
// Usage: node research/run-paired-backtest.mjs /path/to/verified-archive-predictions.json
// Input must be an array of {fixtureId, date, homeGoals, awayGoals,
// identity_verified:true, score_verified:true, models:{'v1.2':{home,draw,away},...}}.
// Never queries production D1 or consumes a provider quota.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {comparePairedModels} from './calibration-metrics.mjs';
import {evaluateChronologicalHoldout} from './chronological-holdout.mjs';
const names=['v1.2','v1.3','v1.4'];
export function prepareVerifiedPairs(records){
 if(!Array.isArray(records))throw new TypeError('Expected an array');
 const seen=new Set(),rows=[];let excluded=0;
 for(const r of records){
  if(r?.identity_verified!==true||r?.score_verified!==true||typeof r.fixtureId!=='string'||!r.fixtureId||typeof r.date!=='string'||!Number.isFinite(Date.parse(r.date))||!Number.isInteger(r.homeGoals)||r.homeGoals<0||!Number.isInteger(r.awayGoals)||r.awayGoals<0||!r.models||!names.every(n=>r.models[n])){excluded++;continue;}
  if(seen.has(r.fixtureId))throw new Error('Duplicate verified fixture: '+r.fixtureId);
  seen.add(r.fixtureId);
  rows.push({fixtureId:r.fixtureId,date:r.date,outcome:r.homeGoals>r.awayGoals?'home':r.homeGoals===r.awayGoals?'draw':'away',models:r.models});
 }
 return {rows,excluded};
}
export function backtest(records){
 const {rows,excluded}=prepareVerifiedPairs(records);
 if(!rows.length)return {status:'insufficient_verified_data',verifiedPairedMatches:0,excluded,comparison:null};
 return {status:'evaluated',verifiedPairedMatches:rows.length,excluded,comparison:comparePairedModels(rows,names),chronologicalHoldout:evaluateChronologicalHoldout(rows)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const file=process.argv[2];
 if(!file){console.error('Provide a local verified predictions JSON file');process.exitCode=2;}
 else try{
  const result=backtest(JSON.parse(await readFile(file,'utf8')));
  console.log(JSON.stringify(result,null,2));
  if(result.status!=='evaluated')process.exitCode=2;
 }catch(error){console.error(error.message);process.exitCode=1;}
}
