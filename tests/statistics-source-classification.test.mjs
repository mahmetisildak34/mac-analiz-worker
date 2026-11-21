import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  normalizeTeam, normalizeLeague, sameCompetition, classifyStatisticsPayload, buildStatisticsProviderBatches
} from "../statistics-repair-bulk.js";

assert.equal(normalizeTeam("Man Utd"), "manchester united");
assert.equal(normalizeTeam("Manchester United FC"), "manchester united");
assert.equal(normalizeTeam("Inter"), "inter milan");
assert.equal(normalizeTeam("Inter Milan"), "inter milan");
assert.equal(normalizeTeam("Amed SFK"), "amedspor");
assert.equal(normalizeTeam("Erzurum BB"), "erzurumspor");

assert.equal(normalizeLeague("UEFA Champions League"), "uefa champions league");
assert.equal(normalizeLeague("Champions League UEFA"), "uefa champions league");
assert.equal(normalizeLeague("French Cup"), "coupe de france");
assert.equal(normalizeLeague("Coupe de France"), "coupe de france");
assert.equal(normalizeLeague("International Friendlies"), "international friendly");

assert.equal(sameCompetition(
  {league_id:"101",league_name:"UEFA Champions League",country:"Europe"},
  {league_id:"999",league_name:"Champions League UEFA",country:"Europe"}
), true);
assert.equal(sameCompetition(
  {league_id:"101",league_name:"UEFA Champions League",country:"Europe"},
  {league_id:"999",league_name:"AFC Champions League",country:"Asia"}
), false);
assert.equal(sameCompetition(
  {league_id:"101",league_name:"UEFA Champions League",country:"Europe"},
  {league_id:"101",league_name:"Different Provider Label",country:"Europe"}
), true);

const full = {teams:[
  {team:"Home",statistics:[
    {name:"totalShots",value:10},{name:"shotsOnTarget",value:4},{name:"possessionPct",value:55},
    {name:"wonCorners",value:5},{name:"foulsCommitted",value:11},{name:"yellowCards",value:2},{name:"redCards",value:0}
  ]},
  {team:"Away",statistics:[
    {team:"Away",name:"totalShots",value:8},{name:"shotsOnTarget",value:3},{name:"possessionPct",value:45},
    {name:"wonCorners",value:4},{name:"foulsCommitted",value:9},{name:"yellowCards",value:1},{name:"redCards",value:0}
  ]}
]};
assert.equal(classifyStatisticsPayload(JSON.stringify(full)), "full");
const partial = structuredClone(full);
partial.teams[0].statistics = partial.teams[0].statistics.slice(0,4);
assert.equal(classifyStatisticsPayload(JSON.stringify(partial)), "partial");
assert.equal(classifyStatisticsPayload('{"teams":['), "invalid");
assert.equal(classifyStatisticsPayload('{"teams":[{"statistics":[]},{"statistics":[{"name":"shots"}]}]}'), "invalid");
console.log("Source matching: aliases, competition context, and full/partial/invalid payload classification passed");

const verified = JSON.parse(readFileSync(new URL("../STATISTICS_REPAIR_VERIFIED_2026-11-21.json", import.meta.url), "utf8"));
assert.equal(verified.counts.full, 1);
assert.equal(verified.counts.partial, 0);
assert.equal(verified.fullMatches.length, 1);
const evidence = verified.fullMatches[0];
assert.equal(evidence.fixture_id, "espn-fra.1-401876395");
assert.equal(createHash("sha256").update(evidence.statistics_json, "utf8").digest("hex"), evidence.statistics_sha256);
const payload = JSON.parse(evidence.statistics_json);
assert.equal(payload.teams[0].homeAway, "home");
assert.equal(payload.teams[1].homeAway, "away");
assert.ok(payload.teams.every(team => ["totalShots","shotsOnTarget","possessionPct","wonCorners","foulsCommitted","yellowCards","redCards"].every(name => team.statistics.some(s => s.name === name))));
console.log("Separate verified manifest and SHA-256 evidence check passed");

const inventory = JSON.parse(readFileSync(new URL("../STATISTICS_REPAIR_CANDIDATE_INVENTORY_2026-11-21.json", import.meta.url), "utf8"));
const batchPlan = buildStatisticsProviderBatches(inventory.candidates, 25);
assert.equal(batchPlan.batch_size, 25);
assert.equal(batchPlan.candidate_count, 677, "one already-verified ESPN fixture is excluded from research batches");
assert.equal(batchPlan.batch_count, 29);
assert.deepEqual(
  batchPlan.batches.reduce((acc,b) => (acc[b.provider_group]=(acc[b.provider_group]||0)+b.count,acc), {}),
  {"API-Football":300,"ESPN":226,"UEFA":61,"SportScore":67,"Football-Data":23}
);
assert.ok(batchPlan.batches.every(batch => batch.count > 0 && batch.count <= 25));
assert.deepEqual(batchPlan.batches.slice(0,12).map(b=>b.provider_group),Array(12).fill("API-Football"));
assert.equal(buildStatisticsProviderBatches(inventory.candidates,100).batch_size,25,"batch size is hard capped at 25");
assert.throws(()=>buildStatisticsProviderBatches([...inventory.candidates,inventory.candidates[0]],25),/duplicated/);
console.log("Provider-priority 25-fixture batch plan validation passed");

const persistedPlan = JSON.parse(readFileSync(new URL("../STATISTICS_REPAIR_BATCH_PLAN_2026-11-21.json", import.meta.url), "utf8"));
assert.equal(persistedPlan.remaining_candidate_count, batchPlan.candidate_count);
assert.equal(persistedPlan.batch_count, batchPlan.batch_count);
assert.ok(persistedPlan.batches.every(batch => batch.count <= 25));
assert.equal(persistedPlan.execution_policy.api_football_requests_started, 0);

assert.equal(inventory.production_candidate_count, 678);
assert.equal(inventory.provider_counts["API-Football"], 300);
assert.equal(inventory.provider_counts.ESPN, 227);
assert.equal(inventory.provider_counts.SportScore, 67);
assert.equal(inventory.provider_counts.UEFA, 61);
assert.equal(inventory.provider_counts["Football-Data"], 23);
assert.ok(inventory.candidates.filter(x=>x.provider_group==="API-Football").every(x=>x.provider_identity_verified===true));
assert.equal(inventory.candidates.filter(x=>x.provider_group==="ESPN"&&x.source==="espn").length,45);
assert.equal(inventory.candidates.filter(x=>x.provider_group==="ESPN"&&x.source==="app").length,81);
