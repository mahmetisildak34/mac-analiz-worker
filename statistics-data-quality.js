// Pure, fail-closed classification. No D1, network, or state mutations.
const aliases=[
 ["totalshots","shots","total shots"],["shotsontarget","shots on target","shots on goal"],
 ["possessionpct","ball possession","possession"],["woncorners","corner kicks","corners"],
 ["foulscommitted","fouls committed","fouls"],["yellowcards","yellow cards"],["redcards","red cards"]
].map(xs=>xs.map(x=>x.replace(/[^a-z0-9]/g,"")));
const canonical=x=>String(x??"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]/g,"");
function number(value,metric){
 if(value===null||value===undefined||typeof value==="boolean")return null;
 if(typeof value!=="string"&&typeof value!=="number")return null;
 const s=String(value).trim().replace(/%$/,"").trim();
 if(!s||!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(s))return null;
 const n=Number(s);if(!Number.isFinite(n))return null;
 if(metric===2)return n<=100?n:null;
 return Number.isSafeInteger(n)&&n>=0&&n<=10000?n:null;
}
export function assessStatistics(raw,{home_team,away_team,provenance_verified=false,identity_verified=false,conflicting=false}={}){
 let data;try{data=typeof raw==="string"?JSON.parse(raw):raw}catch{return {status:"missing",structural_complete:false,metrics_present:0,missing_metrics:[0,1,2,3,4,5,6],reason:"invalid_json"}}
 const teams=Array.isArray(data?.teams)?data.teams:Array.isArray(data?.response)?data.response:null;
 if(conflicting)return {status:"conflicting",structural_complete:false,reason:"identity_or_source_conflict"};
 if(!teams||teams.length!==2||teams.some(t=>!Array.isArray(t?.statistics)))return {status:"missing",structural_complete:false,reason:"two_teams_required"};
 const expected=[home_team,away_team];
 for(let i=0;i<2;i++){
  const t=teams[i];const actual=t.team?.name??t.team_name??t.name;
  if(expected[i]&&actual&&canonical(actual)!==canonical(expected[i]))return {status:"conflicting",structural_complete:false,reason:"home_away_mismatch"};
  if(expected[i]&&!actual)return {status:"provenance_review",structural_complete:false,reason:"team_identity_unconfirmed"};
 }
 const perTeam=teams.map(t=>aliases.map((group,metric)=>{
  const matches=t.statistics.filter(s=>group.includes(canonical(s?.name??s?.type??s?.displayName)));
  if(matches.length!==1)return null;
  return number(matches[0].value??matches[0].displayValue??matches[0].stat,metric);
 }));
 const missing=aliases.map((_,i)=>i).filter(i=>perTeam.some(t=>t[i]===null));
 const structural_complete=missing.length===0;
 if(structural_complete&&perTeam.some(t=>t[1]>t[0]))return {status:"conflicting",structural_complete:false,reason:"shots_on_target_exceed_total"};
 if(structural_complete&&Math.abs(perTeam[0][2]+perTeam[1][2]-100)>2)return {status:"conflicting",structural_complete:false,reason:"possession_sum_invalid"};
 const metrics_present=7-missing.length;
 const status=structural_complete?(identity_verified&&provenance_verified?"verified_full":"provenance_review"):metrics_present?"partial":"missing";
 return {status,structural_complete,metrics_present,missing_metrics:missing,reason:structural_complete&&status!=="verified_full"?"identity_and_provenance_required":null};
}
