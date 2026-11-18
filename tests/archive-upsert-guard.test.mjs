import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const sql = worker.split("\n").find(line => line.includes('const sql = "INSERT INTO matches'));
assert.ok(sql, "ESPN archive upsert SQL must be present");
assert.ok(sql.includes("WHERE matches.league_id IS NOT excluded.league_id"), "upsert must skip rows when values are unchanged");
for (const field of ["league_name","country","kickoff","status","home_team_id","home_team","away_team_id","away_team","home_goals","away_goals"]) {
  assert.ok(sql.includes(`matches.${field} IS NOT excluded.${field}`), `no-op guard must compare ${field}`);
}
assert.ok(!sql.includes("statistics_json=excluded.statistics_json"), "upsert must not overwrite statistics");
assert.ok(!worker.includes("const quotaState = await env.DB.prepare"), "unused quota state read must remain removed");
assert.ok(worker.includes("const reservation = await env.DB.prepare(\n          \"UPDATE mam_api_quota_guard SET used = used + 1"), "atomic quota reservation must remain in place");
console.log("Archive upsert and quota-read regression tests passed.");
