import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const start = worker.indexOf('if (path === "archive/sync-status"');
assert.ok(start >= 0, "sync-status endpoint must exist");
const end = worker.indexOf('if (path === "archive/priority-league-status"', start);
assert.ok(end > start, "sync-status endpoint boundary must exist");
const block = worker.slice(start, end);

assert.ok(
  block.includes('env.MAM_KV.get("mam:d1-status-cache:v2")'),
  "sync-status must reuse the cached D1 aggregate"
);
assert.ok(
  block.includes('cachedD1Status.missingStatisticsBySource.find'),
  "sync-status must derive ESPN missing-stat count from cached source aggregates"
);
assert.ok(
  !block.includes("env.DB.prepare("),
  "15-minute sync-status telemetry must not scan D1"
);
assert.ok(
  block.includes('missingStatisticsInD1 === null'),
  "unknown cached count must not incorrectly report completion"
);
assert.ok(
  block.includes("missingStatisticsCountUpdatedAt"),
  "the age of the cached count must be visible"
);
console.log("sync-status D1 read-quota regression test passed.");
