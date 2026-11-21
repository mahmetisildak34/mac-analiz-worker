// One-request, read-only TheSportsDB free V1 pilot. No retry, no persistence, no secrets.
const url="https://www.thesportsdb.com/api/v1/json/123/lookupeventstats.php?id=1032723";
const required=["total_shots","shots_on_target","possession","corners","fouls","yellow_cards","red_cards"];
const controller=new AbortController();
const timeout=setTimeout(()=>controller.abort(),12000);
let status=null, contentType=null, payload=null, error=null;
try{
 const response=await fetch(url,{method:"GET",redirect:"error",signal:controller.signal,headers:{"Accept":"application/json","User-Agent":"mac-analiz-worker-readonly-pilot/1.0"}});
 status=response.status;contentType=response.headers.get("content-type");
 if(!response.ok)throw new Error("HTTP "+status);
 const raw=await response.text();
 if(raw.length>200000)throw new Error("Response exceeds 200 KB");
 payload=JSON.parse(raw);
}catch(e){error=String(e.message||e)}finally{clearTimeout(timeout)}
const entries=payload&&typeof payload==="object"?(payload.eventstats??payload.stats??[]):[];
const rows=Array.isArray(entries)?entries:[];
const names=[...new Set(rows.map(x=>String(x.strStat||x.strStatName||x.strType||x.strName||x.strStatistic||x.name||"")).filter(Boolean))];
const map={total_shots:["total shots","shots total"],shots_on_target:["shots on goal","shots on target"],possession:["ball possession","possession"],corners:["corner kicks","corners"],fouls:["fouls"],yellow_cards:["yellow cards"],red_cards:["red cards"]};
const present=Object.fromEntries(required.map(k=>[k,names.some(n=>map[k].includes(n.toLowerCase().trim()))]));
const ids=[...new Set(rows.map(x=>x.idEvent).filter(Boolean).map(String))];
const upstream=[...new Set(rows.map(x=>x.idApiFootball).filter(Boolean).map(String))];
const report={source:"TheSportsDB free V1",endpoint:url,request_count:1,http_status:status,content_type:contentType,json_valid:payload!==null,entry_count:rows.length,event_ids:ids,upstream_api_football_ids:upstream,home_away_from_stats:rows.map(x=>({home:x.strHomeTeam??null,away:x.strAwayTeam??null})).filter(x=>x.home||x.away).slice(0,1),score_from_stats:rows.map(x=>({home:x.intHomeScore??null,away:x.intAwayScore??null})).filter(x=>x.home!==null||x.away!==null).slice(0,1),stat_types:names,required_metrics_present:present,all_seven_present:required.every(k=>present[k]),plan_fixture_match_verified:false,production_transfer_ready:false,error};
console.log(JSON.stringify(report,null,2));
if(error)process.exitCode=1;
