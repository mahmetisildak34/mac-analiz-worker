import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const indexes = worker.slice(worker.indexOf("async function ensureArchiveIndexes"), worker.indexOf("// KV archive writes"));
assert.ok(indexes.includes("idx_matches_kickoff_fixture_source"), "keyset source index must exist");
assert.ok(indexes.includes("idx_matches_source_kickoff_fixture"), "keyset ESPN index must exist");

const scheduledStart = worker.indexOf("async scheduled(event, env, ctx)");
const scheduledEnd = worker.indexOf("if (isHourlySync || !env.MAM_KV) return;", scheduledStart);
const scheduled = worker.slice(scheduledStart, scheduledEnd);
assert.ok(!scheduled.includes("normalizeKnownLeagueCountries(env)"), "daily schedule must not run the broad LIKE-based country normalization scans");
assert.ok(scheduled.includes('mam:cross-source-enrichment-last:v7'), "cross-source task must use the refreshed v7 throttle key");
console.log("D1 bounded-read and maintenance regression tests passed.");
