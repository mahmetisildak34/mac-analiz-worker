// Offline rolling-origin evaluation: never train on a future match.
// Input rows are already verified, chronologically dated and paired predictions.
import {evaluateCalibration} from './calibration-metrics.mjs';
export function evaluateChronologicalHoldout(rows,{holdoutFraction=.2,minTrain=30,minHoldout=10}={}){
 if(!Array.isArray(rows)||!(holdoutFraction>0&&holdoutFraction<1)||!Number.isInteger(minTrain)||!Number.isInteger(minHoldout)||minTrain<1||minHoldout<1)throw new RangeError('Invalid split configuration');
 const seen=new Set();
 for(const row of rows){
  if(typeof row?.fixtureId!=='string'||!row.fixtureId||seen.has(row.fixtureId)||typeof row.date!=='string'||!/^\d{4}-\d{2}-\d{2}/.test(row.date)||!Number.isFinite(Date.parse(row.date)))throw new RangeError('Missing, duplicate or invalid fixture metadata');
  seen.add(row.fixtureId);
 }
 const sorted=[...rows].sort((a,b)=>Date.parse(a.date)-Date.parse(b.date)||a.fixtureId.localeCompare(b.fixtureId));
 const cut=Math.floor(sorted.length*(1-holdoutFraction));
 if(cut<minTrain||sorted.length-cut<minHoldout)return {status:'insufficient_data',trainCount:cut,holdoutCount:sorted.length-cut,models:null};
 // Identical timestamps must not be split between training and evaluation.
 if(Date.parse(sorted[cut-1].date)>=Date.parse(sorted[cut].date))return {status:'ambiguous_boundary',trainCount:cut,holdoutCount:sorted.length-cut,models:null};
 const testRows=sorted.slice(cut),models={};
 for(const name of ['v1.2','v1.3','v1.4']){
  models[name]=evaluateCalibration(testRows.map(r=>({outcome:r.outcome,probabilities:r.models?.[name]})));
 }
 return {status:'evaluated',trainCount:cut,holdoutCount:testRows.length,trainThrough:sorted[cut-1].date,holdoutFrom:sorted[cut].date,models};
}
