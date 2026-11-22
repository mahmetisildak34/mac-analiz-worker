// Research-only, evidence-gated, paired model reliability report.
// No historical results are inferred from post-match features. 1X2 only:
// total-goals and first-half probabilities need separately captured pre-kickoff evidence.
import {prepareVerifiedPairs} from './run-paired-backtest.mjs';
import {auditPredictionProvenance} from './prediction-provenance.mjs';
import {comparePairedModels} from './calibration-metrics.mjs';
import {evaluateChronologicalHoldout} from './chronological-holdout.mjs';
const VERSIONS=['v1.2','v1.3','v1.4'];
export function wilsonInterval(successes,total,z=1.959963984540054){
 if(!Number.isInteger(successes)||!Number.isInteger(total)||total<1||successes<0||successes>total||!Number.isFinite(z)||z<=0)
  throw new RangeError('Invalid binomial sample');
 const p=successes/total,d=1+z*z/total,c=(p+z*z/(2*total))/d;
 const h=z*Math.sqrt(p*(1-p)/total+z*z/(4*total*total))/d;
 return {lower:Math.max(0,c-h),upper:Math.min(1,c+h)};
}
const split=(rows,key)=>Object.fromEntries([...new Set(rows.map(key))].sort().map(group=>[group,rows.filter(r=>key(r)===group)]));
const report=(rows,minSample)=>{
 if(rows.length<minSample)return {status:'insufficient_verified_data',count:rows.length,comparison:null,accuracy95:null};
 const comparison=comparePairedModels(rows,VERSIONS);
 const accuracy95=Object.fromEntries(VERSIONS.map(version=>{
  const correct=rows.filter(r=>{
   const p=r.models[version];
   const best=['home','draw','away'].reduce((a,b)=>p[b]>p[a]?b:a,'home');
   return best===r.outcome;
  }).length;
  return [version,wilsonInterval(correct,rows.length)];
 }));
 return {status:'evaluated',count:rows.length,comparison,accuracy95};
};
export function evaluateEvidenceReliability(records,{minSample=50,minSegment=20,minTrain=30,minHoldout=10}={}){
 if(!Array.isArray(records)||![minSample,minSegment,minTrain,minHoldout].every(n=>Number.isInteger(n)&&n>=1))
  throw new RangeError('Invalid evaluation thresholds');
 const audit=auditPredictionProvenance(records);
 const prepared=prepareVerifiedPairs(audit.accepted);
 const metadata=new Map(audit.accepted.map(r=>[r.fixtureId,r]));
 const rows=prepared.rows.map(r=>({...r,leagueId:metadata.get(r.fixtureId)?.leagueId??null}));
 const overall=report(rows,minSample);
 const rejected=audit.rejectedCount+prepared.excluded;
 if(overall.status!=='evaluated')return {status:'insufficient_verified_data',verifiedPairedMatches:rows.length,rejected,overall,chronological:null,byLeague:{},byOutcome:{},markets:{fullTime1X2:overall,totalGoals:{status:'missing_pre_match_probabilities'},firstHalf:{status:'missing_pre_match_probabilities'}}};
 const chronological=evaluateChronologicalHoldout(rows,{minTrain,minHoldout});
 const status=chronological.status==='evaluated'?'evaluated':'insufficient_chronological_holdout';
 const byLeague=Object.fromEntries(Object.entries(split(rows,r=>r.leagueId??'unknown')).map(([k,v])=>[k,report(v,minSegment)]));
 const byOutcome=Object.fromEntries(Object.entries(split(rows,r=>r.outcome)).map(([k,v])=>[k,report(v,minSegment)]));
 return {status,verifiedPairedMatches:rows.length,rejected,overall,chronological,
  byLeague,byOutcome,markets:{fullTime1X2:overall,totalGoals:{status:'missing_pre_match_probabilities'},firstHalf:{status:'missing_pre_match_probabilities'}}};
}
