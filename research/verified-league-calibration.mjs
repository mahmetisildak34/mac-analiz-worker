// League reliability from independently verified pre-kickoff prediction/result pairs.
import {evaluateCalibration} from './calibration-metrics.mjs';
const versions=['v1.2','v1.3','v1.4'];
const outcomes=['home','draw','away'];
const wilson=(hits,n,z=1.96)=>{if(!n)return null;const p=hits/n,d=1+z*z/n,c=(p+z*z/(2*n))/d,h=z*Math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d;return {lower:Math.max(0,c-h),upper:Math.min(1,c+h)};};
export function calibrateVerifiedLeagues(pairs,{minSamples=30,bins=10}={}){
 if(!Array.isArray(pairs)||!Number.isInteger(minSamples)||minSamples<2)throw new TypeError('Invalid calibration input');
 const groups=new Map(),seen=new Set();
 for(const row of pairs){
  if(!row||row.identity_verified!==true||row.score_verified!==true||!row.fixtureId||!row.leagueId||
   !/^[a-f0-9]{64}$/.test(row.predictionEvidenceSha256??'')||!Number.isInteger(row.homeGoals)||row.homeGoals<0||
   !Number.isInteger(row.awayGoals)||row.awayGoals<0||!Number.isFinite(Date.parse(row.date))||
   !versions.every(v=>row.models?.[v]&&Number.isFinite(Date.parse(row.models[v].predictedAt))&&Date.parse(row.models[v].predictedAt)<Date.parse(row.date)))throw new Error('Unverified or late prediction pair');
  // ESPN fixture identifiers may be reused across independent competitions.
  const identity=String(row.leagueId)+'\u0000'+String(row.fixtureId);
  if(seen.has(identity))throw new Error('Duplicate fixture');seen.add(identity);
  const outcome=row.homeGoals>row.awayGoals?'home':row.homeGoals<row.awayGoals?'away':'draw';
  if(!groups.has(row.leagueId))groups.set(row.leagueId,[]);
  groups.get(row.leagueId).push({outcome,models:row.models});
 }
 const leagues={};
 for(const [leagueId,rows] of groups){
  const models={};
  for(const version of versions){
   const metrics=evaluateCalibration(rows.map(r=>({outcome:r.outcome,probabilities:r.models[version]})),{bins});
   models[version]={...metrics,reliability:metrics.reliability.map(b=>{
    const accuracy95CI=b.count?wilson(Math.round(b.accuracy*b.count),b.count):null;
    // Only flag statistical overconfidence when even the 95% upper bound
    // is below the mean predicted confidence, with adequate bin support.
    const overconfidenceStatus=b.count<minSamples?'insufficient_sample':
      accuracy95CI.upper<b.confidence?'overconfident':'not_established';
    return {...b,accuracy95CI,overconfidenceStatus};
   })};
  }
  leagues[leagueId]={sampleSize:rows.length,status:rows.length>=minSamples?'descriptive_calibration':'insufficient_sample',models};
 }
 return {totalVerifiedPairs:seen.size,minSamples,defaultModel:'v1.2',leagues};
}
