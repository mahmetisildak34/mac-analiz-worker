// TheSportsDB discovery: <=3 searches and <=1 stats GET, no retries, no writes.
// All candidate identities come from the immutable plan plus independently researched scores.
import {readFileSync} from "node:fs";
const root=new URL("../",import.meta.url);
const plan=JSON.parse(readFileSync(new URL("STATISTICS_REPAIR_BATCH_PLAN_2026-11-21.json",root),"utf8"));
const candidates=[
 {source:"app",fixture_id:"1649529",home:"Charlotte Independence",away:"Boise",league:"USL League One",score:"4-2",date:"2026-11-14",search:"Charlotte Independence vs Athletic Club Boise",aliases:{away:["athletic club boise","ac boise","boise"]}},
 {source:"app",fixture_id:"1644691",home:"Jamaica",away:"Mexico",league:"CONCACAF Nations League",score:"3-2",date:"2026-11-14",search:"Jamaica vs Mexico"},
 {source:"app",fixture_id:"1649527",home:"Charleston Battery",away:"Louisville City",league:"USL Championship",score:"0-2",date:"2026-11-14",search:"Charleston Battery vs Louisville City"}
];
const normalize=s=>String(s??"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
const equivalent=(actual,expected,aliases=[])=>[expected,...aliases].some(x=>normalize(actual)===normalize(x));
const base="https://www.thesportsdb.com/api/v1/json/123/";
let requests=0;const budget=4;
async function get(path,query){
 if(requests>=budget)throw Error("HTTP request budget exhausted");
 requests++;
 const u=new URL(path,base);for(const [k,v] of Object.entries(query))u.searchParams.set(k,v);
 const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);
 try{const res=await fetch(u,{redirect:"error",signal:controller.signal,headers:{Accept:"application/json","User-Agent":"mac-analiz-worker-discovery-pilot/1.0"}});
 const body=await res.text();if(body.length>200000)throw Error("response >200KB");
 return {status:res.status,url:u.toString(),json:JSON.parse(body)};
 }finally{clearTimeout(timer)}
}
const reports=[];let matched=null;
for(const c of candidates){
 const row=plan.batches.flatMap(b=>b.candidates).find(x=>x.source===c.source&&String(x.fixture_id)===c.fixture_id);
 if(!row)throw Error("Candidate not in plan: "+c.fixture_id);
 const out={source:c.source,fixture_id:c.fixture_id,expected:{home:c.home,away:c.away,date:c.date,league:c.league,score:c.score},search_http_status:null,search_endpoint:null,result_count:0,results:[],verified_id_event:null,error:null};
 try{
 const response=await get("searchevents.php",{e:c.search});out.search_http_status=response.status;out.search_endpoint=response.url;
 const events=Array.isArray(response.json.event)?response.json.event:[];
 out.result_count=events.length;
 for(const e of events.slice(0,10)){
 const date=String(e.dateEvent??"").slice(0,10),score=e.intHomeScore!=null&&e.intAwayScore!=null?e.intHomeScore+"-"+e.intAwayScore:null;
 const teams=equivalent(e.strHomeTeam,c.home,c.aliases?.home)&&equivalent(e.strAwayTeam,c.away,c.aliases?.away);
 const dateMatch=date===c.date;
 const scoreMatch=score===c.score;
 // League names must match explicitly; similar words alone do not count as verified.
 const leagueMatch=equivalent(e.strLeague,c.league);
 const verified=teams&&dateMatch&&scoreMatch&&leagueMatch&&Boolean(e.idEvent);
 out.results.push({idEvent:e.idEvent??null,home:e.strHomeTeam??null,away:e.strAwayTeam??null,date,league:e.strLeague??null,score,teams_match:teams,date_match:dateMatch,score_match:scoreMatch,league_match:leagueMatch,verified});
 if(verified&&!matched)matched={idEvent:String(e.idEvent),source:c.source,fixture_id:c.fixture_id};
 }
 }catch(e){out.error=String(e.message??e)}
 reports.push(out);
}
let stats=null;
if(matched){
 try{
 const response=await get("lookupeventstats.php",{id:matched.idEvent});
 const rows=Array.isArray(response.json.eventstats)?response.json.eventstats:[];
 const types=[...new Set(rows.map(x=>String(x.strStat??"")).filter(Boolean))];
 const synonyms={shots:["total shots"],shots_on_target:["shots on goal","shots on target"],possession:["ball possession","possession"],corners:["corner kicks","corners"],fouls:["fouls"],yellow_cards:["yellow cards"],red_cards:["red cards"]};
 const coverage=Object.fromEntries(Object.entries(synonyms).map(([k,v])=>[k,types.some(t=>v.includes(normalize(t)))]));
 stats={http_status:response.status,url:response.url,source_fixture:matched,entry_count:rows.length,types,coverage,covered:Object.values(coverage).filter(Boolean).length,upstream_api_football_ids:[...new Set(rows.map(x=>x.idApiFootball).filter(Boolean))],full_verified:false};
 }catch(e){stats={error:String(e.message??e),full_verified:false}}
}
console.log(JSON.stringify({request_count:requests,searches:reports.length,verified_matches:reports.flatMap(x=>x.results.filter(y=>y.verified)).length,match:matched,search_reports:reports,statistics:stats,new_verified_json:0,production_transfer_ready:false},null,2));
