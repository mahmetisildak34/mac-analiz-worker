import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const upsert = worker.match(/const sql = "INSERT INTO matches[\\s\\S]*?ON CONFLICT\\(source, fixture_id\\) DO UPDATE SET[\\s\\S]*?";/)?.[0];
assert.ok(upsert, "ESPN archive upsert SQL must be present");
assert.match(upsert, /WHERE matches\\.league_id IS NOT excluded\\.league_id/, "upsert must skip rows when values are unchanged");
for (const field of ["league_name","country","kickoff","status","home_team_id","home_team","away_team_id","away_team","home_goals","away_goals"]) {
  assert.ok(upsert.includes(`matches.${field} IS NOT excluded.${field}`), `no-op guard must compare ${field}`);
}
assert.doesNotMatch(upsert, /statistics_json=excluded\\.statistics_json/, "upsert must not overwrite statistics");
console.log("Archive upsert no-op guard tests passed.");
