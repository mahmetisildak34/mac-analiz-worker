import assert from "node:assert/strict";
import {runStatisticsApiCron} from "../statistics-api-cron.js";
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
