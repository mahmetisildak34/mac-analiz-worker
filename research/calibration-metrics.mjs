// Research-only calibration metrics. Never reads or mutates production data.
// Each observation: { probabilities: {home,draw,away}, outcome: 'home'|'draw'|'away' }.
const OUTCOMES=['home','draw','away'];
export function evaluateCalibration(observations,{bins=10}={}){
 if(!Array.isArray(observations)||!Number.isInteger(bins)||bins<2||bins>100)throw new RangeError('Invalid evaluation input');
 const groups=Array.from({length:bins},()=>({count:0,confidenceSum:0,accuracySum:0}));
 let brier=0,logLoss=0,correct=0;
 for(const row of observations){
  const p=row?.probabilities;
  if(!p||!OUTCOMES.includes(row.outcome)||!OUTCOMES.every(k=>typeof p[k]==='number'&&Number.isFinite(p[k])&&p[k]>=0&&p[k]<=1)||Math.abs(OUTCOMES.reduce((s,k)=>s+p[k],0)-1)>1e-8)throw new RangeError('Invalid probability or outcome');
  const best=OUTCOMES.reduce((a,k)=>p[k]>p[a]?k:a,'home');
  const confidence=p[best],hit=Number(best===row.outcome);
  const bucket=groups[Math.min(bins-1,Math.floor(confidence*bins))];
  bucket.count++;bucket.confidenceSum+=confidence;bucket.accuracySum+=hit;
  correct+=hit;
  for(const k of OUTCOMES)brier+=(p[k]-Number(k===row.outcome))**2;
  logLoss-=Math.log(Math.max(Number.MIN_VALUE,p[row.outcome]));
 }
 const n=observations.length;
 const reliability=groups.map((g,i)=>({lower:i/bins,upper:(i+1)/bins,count:g.count,confidence:g.count?g.confidenceSum/g.count:null,accuracy:g.count?g.accuracySum/g.count:null}));
 const ece=n?groups.reduce((s,g)=>s+(g.count?Math.abs(g.accuracySum/g.count-g.confidenceSum/g.count)*g.count/n:0),0):null;
 return {count:n,brier:n?brier/n:null,logLoss:n?logLoss/n:null,accuracy:n?correct/n:null,ece,reliability};
}
export function comparePairedModels(rows,modelNames=['v1.2','v1.3','v1.4']){
 if(!Array.isArray(rows)||!Array.isArray(modelNames)||new Set(modelNames).size!==modelNames.length||!modelNames.length)throw new RangeError('Invalid comparison');
 const results={};
 for(const name of modelNames){
  const sample=rows.map(row=>({outcome:row.outcome,probabilities:row.models?.[name]}));
  results[name]=evaluateCalibration(sample);
 }
 return {pairedMatches:rows.length,models:results};
}
