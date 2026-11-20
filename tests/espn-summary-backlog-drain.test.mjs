import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
assert.match(worker, /const deferredSummaryQueueKey = "mam:espn-summary-deferred:v1";/,
  "deferred queue has a durable KV key");
assert.match(worker, /deferredSummaryQueue\.some\(item => item\.key === key\)/,
  "new scoreboard items are deduplicated against deferred items");
assert.match(worker, /if \(summaryQueue\.length > 0\)[\s\S]{0,260}deferredSummaryQueue\.push/,
  "new scoreboard items are deferred while the older queue is non-empty");
assert.match(worker, /if \(summaryQueue\.length === 0 && deferredSummaryQueue\.length > 0\)[\s\S]{0,220}summaryQueue = deferredSummaryQueue\.slice\(0, 480\)/,
  "deferred items are promoted only after the older queue drains");
assert.match(worker, /put\(deferredSummaryQueueKey, JSON\.stringify\(deferredSummaryQueue\)\)/,
  "deferred items are persisted after each invocation");

console.log("ESPN summary backlog drain regression test passed.");
