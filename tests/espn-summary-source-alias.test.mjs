import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const discoveryStart = worker.indexOf('const discoverySql = "SELECT source, fixture_id AS fixtureId');
const discoveryEnd = worker.indexOf("const missingRows = discoveryCursor", discoveryStart);
assert.ok(discoveryStart >= 0 && discoveryEnd > discoveryStart, "ESPN discovery SQL exists");
const discovery = worker.slice(discoveryStart, discoveryEnd);
assert.ok(discovery.includes("source IN ('ESPN','espn')"), "both ESPN source casings are included");
assert.ok(discovery.includes("source = 'app' AND fixture_id LIKE 'espn-%'"), "ESPN IDs stored under app are included");
assert.ok(discovery.includes("statistics_json IS NULL OR TRIM(statistics_json) IN"), "only empty rows enter the summary queue");
assert.ok(discovery.includes("source > ?"), "keyset cursor distinguishes equal fixture IDs across sources");

const summaryStart = worker.indexOf("const summaryCompetitors =");
const summaryEnd = worker.indexOf("if (hasActualStatistics)", summaryStart);
assert.ok(summaryStart >= 0 && summaryEnd > summaryStart, "summary event identity check exists");
const identity = worker.slice(summaryStart, summaryEnd);
assert.ok(identity.includes("homeCompetitor") && identity.includes("awayCompetitor"), "home and away sides are explicit");
assert.ok(identity.includes("sameProviderTeam"), "provider team IDs/names are verified against the target row");
assert.ok(identity.includes("home/away order mismatch"), "reversed or mismatched fixtures fail closed");

const writes = worker.slice(worker.indexOf("const pendingWriteResult"), worker.indexOf("for (let i = 0; i < summaryBatch.length", worker.indexOf("const pendingWriteResult")));
assert.ok(writes.includes("WHERE source = ? AND fixture_id = ?"), "pending write is source-scoped");
assert.ok(writes.includes("TRIM(statistics_json) IN ('','{}','[]','null')"), "pending writes never replace populated stats");
const summaryWriteStart = worker.indexOf("const statisticsWriteResult");
const summaryWriteEnd = worker.indexOf("const actualChanges", summaryWriteStart);
const summaryWrite = worker.slice(summaryWriteStart, summaryWriteEnd);
assert.ok(summaryWrite.includes("WHERE source = ? AND fixture_id = ?"), "summary write is source-scoped");
assert.ok(summaryWrite.includes("TRIM(statistics_json) IN ('','{}','[]','null')"), "summary writes never replace populated stats");
assert.ok(worker.includes("updates.slice(i, i + 25)"), "cross-source writes remain bounded to 25");
console.log("ESPN source alias discovery, fixture identity, empty-only persistence and batch limit passed");
