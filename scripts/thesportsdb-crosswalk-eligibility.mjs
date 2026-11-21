// Offline, zero-network TheSportsDB crosswalk eligibility gate.
// Numeric fixture IDs from other providers must NEVER be treated as TheSportsDB IDs.
import {readFileSync} from "node:fs";
const root=new URL("../",import.meta.url);
const read=(name)=>JSON.parse(readFileSync(new URL(name,root),"utf8"));
const plan=read("STATISTICS_REPAIR_BATCH_PLAN_2026-11-21.json");
const manifest=read("STATISTICS_REPAIR_VERIFIED_2026-11-21.json");
const rows=plan.batches.flatMap(b=>b.candidates.map(x=>({...x,batch_number:b.batch_number})));
const evidence=manifest.fullMatches.filter(x=>String(x.provider||"").toLowerCase().includes("thesportsdb") && x.provider_event_id);
const canonical=(s)=>String(s||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]/g,"");
const ready=[];
for(const e of evidence){
 const candidate=rows.find(x=>x.source===e.source&&String(x.fixture_id)===String(e.fixture_id));
 if(!candidate)continue;
 const teams=canonical(e.home)===canonical(candidate.home_team)&&canonical(e.away)===canonical(candidate.away_team);
 const date=String(e.kickoff||"").slice(0,10)===String(candidate.kickoff||"").slice(0,10);
 const league=canonical(e.league)===canonical(candidate.league);
 const score=Boolean(e.verification?.score_verified);
 if(teams&&date&&league&&score)ready.push({source:e.source,fixture_id:e.fixture_id,thesportsdb_event_id:String(e.provider_event_id),batch_number:candidate.batch_number});
}
const report={plan_rows:rows.length,unique_namespaced_fixtures:new Set(rows.map(x=>x.source+"|"+x.fixture_id)).size,existing_manifest_thesportsdb_ids:evidence.length,eligible_exact_crosswalks:ready.length,eligible:ready,request_budget:3,requests_authorized:Math.min(3,ready.length),requests_performed:0,warning:"No provider ID inference; only previously recorded explicit TheSportsDB IDs with independent team/date/league/score evidence may be used. An empty list means no requests should be made."};
console.log(JSON.stringify(report,null,2));
