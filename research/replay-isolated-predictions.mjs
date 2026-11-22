// Offline replay of previously persisted predictions against independently verified
// final results. Never manufactures predictions from completed-match statistics.
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createIsolatedPredictionStore} from './isolated-prediction-store.mjs';
import {backtest} from './run-paired-backtest.mjs';
export async function replayIsolatedPredictions({directory,results,minPaired=50}={}){
 if(!Array.isArray(results)||!Number.isInteger(minPaired)||minPaired<1)throw new RangeError('Verified results and minimum sample required');
 const store=createIsolatedPredictionStore({directory});
 const paired=[],rejected=[];
 const seen=new Set();
 for(const result of results){
  const id=result?.fixtureId;
  if(typeof id!=='string'||!id||seen.has(id)){rejected.push({fixtureId:id??null,reason:'missing_or_duplicate_fixture'});continue;}
  seen.add(id);
  try{paired.push(await store.pair(id,result));}
  catch(error){rejected.push({fixtureId:id,reason:error.message});}
 }
 if(paired.length<minPaired)return {status:'insufficient_verified_data',pairedMatches:paired.length,minPaired,rejected,comparison:null,chronologicalHoldout:null};
 const evaluated=backtest(paired);
 if(evaluated.status!=='evaluated'||evaluated.chronologicalHoldout?.status!=='evaluated')
  return {status:'insufficient_chronological_holdout',pairedMatches:paired.length,minPaired,rejected,comparison:null,chronologicalHoldout:evaluated.chronologicalHoldout??null};
 return {status:'evaluated',pairedMatches:paired.length,minPaired,rejected,comparison:evaluated.comparison,chronologicalHoldout:evaluated.chronologicalHoldout};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [directory,resultsFile]=process.argv.slice(2);
 if(!directory||!resultsFile){console.error('Usage: node research/replay-isolated-predictions.mjs <isolated-directory> <verified-results.json>');process.exitCode=2;}
 else try{
  const result=await replayIsolatedPredictions({directory,results:JSON.parse(await readFile(resultsFile,'utf8'))});
  console.log(JSON.stringify(result,null,2));
  if(result.status!=='evaluated')process.exitCode=2;
 }catch(error){console.error(error.message);process.exitCode=1;}
}
