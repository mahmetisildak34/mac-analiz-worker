// Compare immutable, independently verified pre-match prediction/result pairs.
// Never treat a fixture or a claimed result without verified provenance as evidence.
const versions=['v1.2','v1.3','v1.4'];
const outcome=r=>r.homeGoals>r.awayGoals?'home':r.homeGoals<r.awayGoals?'away':'draw';
export function compareVerifiedPredictions(pairs,{minSamples=30}={}){
 if(!Array.isArray(pairs)||!Number.isInteger(minSamples)||minSamples<2)throw new TypeError('Valid pairs and minimum sample size required');
 const leagues=new Map(),seen=new Set();
 for(const pair of pairs){
  if(!pair||pair.identity_verified!==true||pair.score_verified!==true||
   typeof pair.fixtureId!=='string'||!pair.fixtureId||typeof pair.leagueId!=='string'||!pair.leagueId||
   typeof pair.predictionEvidenceSha256!=='string'||!/^[a-f0-9]{64}$/.test(pair.predictionEvidenceSha256)||
   !Number.isSafeInteger(pair.homeGoals)||pair.homeGoals<0||!Number.isSafeInteger(pair.awayGoals)||pair.awayGoals<0||
   typeof pair.date!=='string'||!/^\\d{4}-\\d{2}-\\d{2}T/.test(pair.date)||!Number.isFinite(Date.parse(pair.date))||
   !pair.models||!versions.every(v=>pair.models[v]))throw new Error('Unverified or incomplete model pair');
  if(seen.has(pair.leagueId+'\\u0000'+pair.fixtureId))throw new Error('Duplicate fixture in comparison');
  seen.add(pair.leagueId+'\\u0000'+pair.fixtureId);
  const result=outcome(pair),row={};
  for(const version of versions){
   const p=pair.models[version];
   if(!['home','draw','away'].every(k=>Number.isFinite(p[k])&&p[k]>=0&&p[k]<=1)||
    Math.abs(p.home+p.draw+p.away-1)>1e-8||typeof p.predictedAt!=='string'||
    !Number.isFinite(Date.parse(p.predictedAt))||!Number.isFinite(Date.parse(pair.date))||
    Date.parse(p.predictedAt)>=Date.parse(pair.date))throw new Error('Invalid or late model prediction');
   const brier=(['home','draw','away'].reduce((sum,k)=>sum+(p[k]-(result===k?1:0))**2,0))/3;
   const logLoss=-Math.log(Math.max(p[result],1e-15));
   row[version]={brier,logLoss,correct:((p.home>=p.draw&&p.home>=p.away?'home':p.draw>=p.away?'draw':'away')===result)?1:0};
  }
  if(!leagues.has(pair.leagueId))leagues.set(pair.leagueId,[]);
  leagues.get(pair.leagueId).push(row);
 }
 const report={totalVerifiedPairs:seen.size,leagues:{},defaultModel:'v1.2'};
 for(const [leagueId,rows] of leagues){
  const models={};
  for(const version of versions){
   const avg=field=>rows.reduce((sum,row)=>sum+row[version][field],0)/rows.length;
   models[version]={brierScore:avg('brier'),logLoss:avg('logLoss'),accuracy:avg('correct')};
  }
  report.leagues[leagueId]={sampleSize:rows.length,status:rows.length>=minSamples?'descriptive_metrics_available':'insufficient_sample',models};
 }
 return report;
}
