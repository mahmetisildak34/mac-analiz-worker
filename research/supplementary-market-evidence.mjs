// Offline supplementary market evidence. Never derives pre-match probabilities from final scores.
import {createHash} from 'node:crypto';
import {evaluateCalibration} from './calibration-metrics.mjs';
import {evaluateChronologicalHoldout} from './chronological-holdout.mjs';
const V=['v1.2','v1.3','v1.4'],OUT=['home','draw','away'];
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const stamp=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(s)&&Number.isFinite(Date.parse(s))?Date.parse(s):NaN;
const probability=p=>typeof p==='number'&&Number.isFinite(p)&&p>=0&&p<=1;
const triple=p=>p&&OUT.every(k=>probability(p[k]))&&Math.abs(OUT.reduce((n,k)=>n+p[k],0)-1)<1e-8;
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x);
export function sealMarketEvidence(input){
 const {fixtureId,leagueId,kickoff,recordedAt,featureAvailableAt,featureSnapshotId,sourceEvidenceId,models}=input??{};
 if(![fixtureId,leagueId,featureSnapshotId,sourceEvidenceId].every(id)||![kickoff,recordedAt,featureAvailableAt].every(x=>Number.isFinite(stamp(x)))||stamp(featureAvailableAt)>stamp(recordedAt)||stamp(recordedAt)>=stamp(kickoff))
  throw new Error('Invalid or late market evidence');
 if(!models||Object.keys(models).length!==3||!V.every(v=>Object.hasOwn(models,v)))throw new Error('Three model versions required');
 const normalized={};
 for(const v of V){
  const m=models[v];
  if(!m||!id(m.codeVersion)||m.predictedAt!==recordedAt||!triple(m.firstHalf1X2)||!m.totalGoals||!Number.isFinite(m.totalGoals.line)||m.totalGoals.line<0||!Number.isInteger(m.totalGoals.line*2)||Math.floor(m.totalGoals.line)!==m.totalGoals.line||!probability(m.totalGoals.over)||!probability(m.totalGoals.under)||Math.abs(m.totalGoals.over+m.totalGoals.under-1)>1e-8)
   throw new Error('Invalid pre-match market probabilities');
  normalized[v]={codeVersion:m.codeVersion,predictedAt:m.predictedAt,firstHalf1X2:{...m.firstHalf1X2},totalGoals:{line:m.totalGoals.line,over:m.totalGoals.over,under:m.totalGoals.under}};
 }
 const payload={fixtureId,leagueId,kickoff,recordedAt,featureAvailableAt,featureSnapshotId,sourceEvidenceId,models:normalized};
 return {...payload,sha256:sha(payload)};
}
export function evaluateMarketEvidence(pairs,{minSample=50,minTrain=30,minHoldout=10}={}){
 if(!Array.isArray(pairs)||![minSample,minTrain,minHoldout].every(x=>Number.isInteger(x)&&x>=1))throw new RangeError('Invalid thresholds');
 const seen=new Set(),rows={firstHalf1X2:[],totalGoals:[]};let rejected=0;
 for(const pair of pairs){
  const e=pair?.evidence,r=pair?.result;
  if(!e||!r||seen.has(e.fixtureId)){rejected++;continue;}
  seen.add(e.fixtureId);
  let valid;
  try{valid=sealMarketEvidence(e).sha256===e.sha256;}catch{valid=false;}
  if(!valid||r.fixtureId!==e.fixtureId||r.leagueId!==e.leagueId||r.identity_verified!==true||r.score_verified!==true||stamp(r.verifiedAt)<stamp(e.kickoff)||!Number.isFinite(stamp(r.verifiedAt))){rejected++;continue;}
  if(r.firstHalfVerified===true&&Number.isInteger(r.firstHalfHomeGoals)&&r.firstHalfHomeGoals>=0&&Number.isInteger(r.firstHalfAwayGoals)&&r.firstHalfAwayGoals>=0){
   const outcome=r.firstHalfHomeGoals>r.firstHalfAwayGoals?'home':r.firstHalfHomeGoals===r.firstHalfAwayGoals?'draw':'away';
   rows.firstHalf1X2.push({fixtureId:e.fixtureId,date:e.kickoff,outcome,models:Object.fromEntries(V.map(v=>[v,e.models[v].firstHalf1X2]))});
  }
  if(r.totalGoalsVerified===true&&Number.isInteger(r.homeGoals)&&r.homeGoals>=0&&Number.isInteger(r.awayGoals)&&r.awayGoals>=0){
   // The threshold must be identical across models for a paired comparison.
   const lines=V.map(v=>e.models[v].totalGoals.line);
   if(new Set(lines).size!==1){rejected++;continue;}
   const outcome=r.homeGoals+r.awayGoals>lines[0]?'home':r.homeGoals+r.awayGoals<lines[0]?'away':null;
   if(outcome)rows.totalGoals.push({fixtureId:e.fixtureId,date:e.kickoff,outcome,models:Object.fromEntries(V.map(v=>[v,{home:e.models[v].totalGoals.over,draw:0,away:e.models[v].totalGoals.under}]))});
  }
 }
 const markets={};
 for(const [market,sample] of Object.entries(rows)){
  if(sample.length<minSample){markets[market]={status:'insufficient_verified_data',count:sample.length,models:null};continue;}
  const chronological=evaluateChronologicalHoldout(sample,{minTrain,minHoldout});
  if(chronological.status!=='evaluated'){markets[market]={status:'insufficient_chronological_holdout',count:sample.length,chronological,models:null};continue;}
  markets[market]={status:'evaluated',count:sample.length,chronological,models:Object.fromEntries(V.map(v=>[v,evaluateCalibration(sample.map(x=>({outcome:x.outcome,probabilities:x.models[v]})))]))};
 }
 return {rejected,markets};
}
