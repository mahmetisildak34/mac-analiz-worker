import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
const load=name=>JSON.parse(readFileSync(new URL("../"+name,import.meta.url),"utf8"));
const protectedManifest=load("STATISTICS_REPAIR_INVENTORY_2026-11-21.json");
const inventory=load("STATISTICS_REPAIR_CANDIDATE_INVENTORY_2026-11-21.json");
const verified=load("STATISTICS_REPAIR_VERIFIED_2026-11-21.json");
const plan=load("STATISTICS_REPAIR_BATCH_PLAN_2026-11-21.json");
const key=x=>x.source+"|"+x.fixture_id;
assert.equal(protectedManifest.matches.length,44);
assert.equal(new Set(protectedManifest.matches.map(x=>key(x.production))).size,44);
for(const row of protectedManifest.matches){
  assert.match(row.preview.statistics_sha256,/^[a-f0-9]{64}$/);
  assert.ok(row.production.fixture_id && row.preview.fixture_id);
  assert.ok(Number(row.preview.statistics_length)>0);
}
assert.equal(inventory.candidates.length,678);
assert.equal(new Set(inventory.candidates.map(key)).size,678);
const protectedKeys=new Set(protectedManifest.matches.map(x=>key(x.production)));
assert.ok(inventory.candidates.every(x=>!protectedKeys.has(key(x))));
assert.deepEqual(inventory.provider_counts,{"ESPN":227,"SportScore":67,"UEFA":61,"Football-Data":23,"API-Football":300});
const verifiedEntries=[...verified.fullMatches,...verified.partialMatches];
assert.equal(verifiedEntries.length,1);
const verifiedMap=new Map(verifiedEntries.map(x=>[key(x),x]));
for(const row of verifiedEntries){
  assert.ok(inventory.candidates.some(x=>key(x)===key(row)),"verified fixture must exist in the 678 inventory");
  const parsed=JSON.parse(row.statistics_json);
  assert.equal(parsed.teams.length,2);
  assert.ok(parsed.teams.every(t=>Array.isArray(t.statistics)&&t.statistics.length>0));
  assert.equal(createHash("sha256").update(row.statistics_json,"utf8").digest("hex"),row.statistics_sha256);
  assert.match(row.source_payload_sha256,/^[a-f0-9]{64}$/);
}
assert.equal(plan.batch_size,25);
assert.equal(plan.batch_count,28);
assert.equal(plan.batches.length,28);
assert.equal(plan.batches.at(-1).count,3);
assert.equal(plan.batches.reduce((n,b)=>n+b.count,0),678);
const flattened=plan.batches.flatMap((b,i)=>{
  assert.equal(b.batch_number,i+1);
  assert.equal(b.count,b.candidates.length);
  assert.equal(b.count,i===27?3:25);
  assert.equal(b.transfer_ready,0,"research plan must not authorize production transfer");
  return b.candidates;
});
assert.equal(new Set(flattened.map(key)).size,678);
assert.deepEqual(new Set(flattened.map(key)),new Set(inventory.candidates.map(key)));
for(const row of flattened){
  const v=verifiedMap.get(key(row));
  assert.equal(row.statistics_sha256,v?.statistics_sha256||null);
  assert.equal(row.transfer_ready,false);
  if(!v) assert.equal(row.matching_status,"not-verified");
}
assert.deepEqual(plan.verification_counts,{full:1,partial:0,unverified:677,transfer_ready:0});
console.log("Manifest and batch integrity passed: 44 protected, 678 unique, 1 verified SHA-256, 28 research batches, zero authorized transfers");
