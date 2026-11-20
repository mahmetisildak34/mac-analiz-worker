import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const start = worker.indexOf("catch (enrichmentError)");
assert.ok(start >= 0, "cross-source enrichment error handler must exist");
const end = worker.indexOf("\n      }\n    }", start);
assert.ok(end > start, "cross-source enrichment error handler boundary must exist");
const block = worker.slice(start, end);
assert.ok(
  block.includes('env.MAM_KV.put("mam:cross-source-enrichment-last:v3", String(Date.now())'),
  "failed D1 scans must set a throttle checkpoint to prevent retries on every 15-minute cron"
);
assert.ok(
  block.includes('env.MAM_KV.put("mam:cross-source-stats:last:v3"'),
  "failure report must remain available in KV"
);
console.log("Cross-source D1 quota backoff regression test passed.");
