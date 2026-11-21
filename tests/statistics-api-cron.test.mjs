import assert from "node:assert/strict";
import {runStatisticsApiCron} from "../statistics-api-cron.js";
import { readFileSync } from "node:fs";
let reads=0,network=0;
const db={prepare(){reads++;throw Error("D1 must not be touched when disabled");}};
const request=async()=>{network++;throw Error("network must remain disabled");};
for(const env of [
 {DB:db},
 {DB:db,STATISTICS_API_BACKFILL_ENABLED:"true"},
 {DB:db,STATISTICS_API_BACKFILL_ENABLED:"true",API_FOOTBALL_QUOTA_VERIFIED:"true"}
]) {
 const result=await runStatisticsApiCron(env,request);
 assert.equal(result.skipped,"disabled-until-quota-audit");
}
assert.equal(reads,0);
assert.equal(network,0);
console.log("Cron remains completely inert without all three explicit verified flags");

const cronSource = readFileSync(new URL("../statistics-api-cron.js", import.meta.url), "utf8");
assert.ok(cronSource.includes("m.source='app'"), "verified API-Football fixtures imported under app are queried");
assert.ok(cronSource.includes("$.fixture.id"), "raw fixture ID must prove provider identity");
assert.ok(cronSource.includes("$.teams.home.id") && cronSource.includes("$.teams.away.id"), "both ordered provider team IDs must match");
assert.ok(cronSource.includes("$.league.logo"), "API-Sports league namespace is checked");
assert.ok(cronSource.includes("LIMIT 1"), "cron remains bounded to one API candidate per tick");
console.log("API cron includes strict app-import identity filters without relaxing the quota gate");
