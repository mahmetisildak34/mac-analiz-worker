// Fourth and final request of the discovery pilot: stats for an independently matched event.
// Discovery response on run 44900204749: Charleston Battery vs Louisville City,
// 2026-11-14, 0-2, league alias American USL Championship = USL Championship.
// Do not infer event ID from the plan's API-Football fixture ID.
const idEvent="2627357";
const url="https://www.thesportsdb.com/api/v1/json/123/lookupeventstats.php?id="+idEvent;
const ac=new AbortController(),timer=setTimeout(()=>ac.abort(),12000);
let report={http_requests:1,source:"app",fixture_id:"1649527",idEvent,discovery_run:"https://github.com/mahmetisildak34/mac-analiz-worker/actions/runs/44900204749",stats_url:url,http_status:null,json_valid:false,stats_types:[],covered:0,seven_stats_complete:false,source_provenance:[],verified_json_created:false,error:null};
try{
 const res=await fetch(url,{redirect:"error",signal:ac.signal,headers:{Accept:"application/json","User-Agent":"mac-analiz-worker-final-fourth-request/1.0"}});
 report.http_status=res.status;const raw=await res.text();if(raw.length>200000)throw Error("Response too large");
 const j=JSON.parse(raw);report.json_valid=true;
 const rows=Array.isArray(j.eventstats)?j.eventstats:[];
 report.stats_types=[...new Set(rows.map(x=>String(x.strStat??"")).filter(Boolean))];
 report.source_provenance=[...new Set(rows.map(x=>x.idApiFootball).filter(Boolean))].map(x=>({upstream_api_football_id:String(x)}));
 const norms=report.stats_types.map(x=>x.toLowerCase().trim());
 const synonyms={shots:["total shots"],shots_on_target:["shots on goal","shots on target"],possession:["ball possession","possession"],corners:["corner kicks","corners"],fouls:["fouls"],yellow_cards:["yellow cards"],red_cards:["red cards"]};
 report.coverage=Object.fromEntries(Object.entries(synonyms).map(([k,v])=>[k,norms.some(n=>v.includes(n))]));
 report.covered=Object.values(report.coverage).filter(Boolean).length;
 report.seven_stats_complete=report.covered===7;
}catch(e){report.error=String(e.message??e)}finally{clearTimeout(timer)}
console.log(JSON.stringify(report,null,2));if(report.error)process.exitCode=1;
