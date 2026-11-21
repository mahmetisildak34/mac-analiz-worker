// Read-only, resumable research audit. Never fetches external data or writes manifests.
import {readFileSync, existsSync} from "node:fs";
import {createHash} from "node:crypto";
const root=new URL("../",import.meta.url);
const read=(name)=>JSON.parse(readFileSync(new URL(name,root),"utf8"));
const fail=(msg)=>{throw new Error(msg)};
const key=(x)=>String(x.source||"")+"|"+String(x.fixture_id||"");
const plan=read("STATISTICS_REPAIR_BATCH_PLAN_2026-11-21.json");
const manifest=read("STATISTICS_REPAIR_VERIFIED_2026-11-21.json");
const protectedInventory=read("STATISTICS_REPAIR_INVENTORY_2026-11-21.json");
if(protectedInventory.matches.length!==44)fail("Protected 44-row inventory changed");
const planRows=plan.batches.flatMap((b,i)=>{if(b.batch_number!==i+1||b.count!==b.candidates.length)fail("Invalid batch "+(i+1));return b.candidates.map((x,j)=>({...x,batch_number:b.batch_number,row_number:j+1}))});
if(planRows.length!==678||plan.batches.length!==28)fail("Unexpected protected plan size");
const namespaceKeys=new Set(planRows.map(key));
if(namespaceKeys.size!==planRows.length)fail("Duplicate source|fixture_id in plan; manual reconciliation required");
const rawIds=new Map();
for(const x of planRows){const id=String(x.fixture_id);if(!rawIds.has(id))rawIds.set(id,[]);rawIds.get(id).push(x)}
const repeated=[...rawIds].filter(([,v])=>v.length>1);
const entries=[...manifest.fullMatches,...(manifest.partialMatches||[])];
const manifestKeys=new Set();
for(const x of entries){
 const k=key(x);if(manifestKeys.has(k))fail("Duplicate manifest entry "+k);
 manifestKeys.add(k);
 if(!namespaceKeys.has(k))fail("Manifest entry absent from plan "+k);
 const payload=JSON.parse(x.statistics_json);
 if(!Array.isArray(payload.teams)||payload.teams.length!==2)fail("Invalid statistics teams "+k);
 const sha=createHash("sha256").update(x.statistics_json,"utf8").digest("hex");
 if(sha!==x.statistics_sha256)fail("SHA-256 mismatch "+k);
}
if(manifest.counts.full!==manifest.fullMatches.length)fail("Manifest full count mismatch");
const states=new Map(),batchReports=[];
const valid=new Set(["full_verified","blocked","source_review","pending"]);
for(const batch of plan.batches){
 const filename="STATISTICS_REPAIR_BATCH_"+String(batch.batch_number).padStart(2,"0")+"_RESEARCH_STATUS_2026-11-21.json";
 if(!existsSync(new URL(filename,root))){batchReports.push({batch:batch.batch_number,file_present:false,pending:batch.count});continue}
 const status=read(filename), rows=status.rows||[];
 if(rows.length!==batch.count)fail("Research row count mismatch batch "+batch.batch_number);
 const tally={full_verified:0,blocked:0,source_review:0,pending:0};
 for(let i=0;i<rows.length;i++){
  const x=rows[i],expected=batch.candidates[i];
  if(String(x.fixture_id)!==String(expected.fixture_id))fail("Fixture order mismatch batch "+batch.batch_number+" row "+(i+1));
  if(!valid.has(x.status))fail("Unknown research status "+x.status);
  tally[x.status]++;
  const k=key(expected);
  if(states.has(k))fail("Duplicate research record for source|fixture_id "+k);
  states.set(k,{batch:batch.batch_number,status:x.status});
 }
 for(const [k,v] of Object.entries(tally))if(status.counts?.[k]!==v)fail("Batch "+batch.batch_number+" "+k+" count mismatch");
 batchReports.push({batch:batch.batch_number,file_present:true,...tally});
}
const queue=planRows.filter(x=>!states.has(key(x))||states.get(key(x)).status==="pending").map(x=>({batch:x.batch_number,row:x.row_number,source:x.source,fixture_id:x.fixture_id,home:x.home_team,away:x.away_team,kickoff:x.kickoff}));
const counts={full_verified:0,blocked:0,source_review:0,pending:queue.length};
for(const x of states.values())if(x.status!=="pending")counts[x.status]++;
const report={schema_version:1,plan_rows:planRows.length,unique_namespaced_fixtures:namespaceKeys.size,unique_raw_fixture_ids:rawIds.size,repeated_raw_fixture_ids:repeated.length,extra_raw_id_occurrences:planRows.length-rawIds.size,raw_id_collisions:repeated.map(([fixture_id,rows])=>({fixture_id,identities:rows.map(x=>({source:x.source,batch:x.batch_number,home:x.home_team,away:x.away_team,kickoff:x.kickoff}))})),protected_inventory_count:protectedInventory.matches.length,manifest_json_count:entries.length,manifest_sha256_checked:entries.length,manifest_full_marked:manifest.fullMatches.length,manifest_transfer_ready_confirmed:0,counts,batches:batchReports,next_pending:queue[0]||null,pending_queue:queue,warning:"Read-only report. A repeated raw ID across sources is NOT a duplicate fixture without provider-specific match identity verification. Research and transfer require external evidence."};
process.stdout.write(JSON.stringify(report,null,2)+"\n");
