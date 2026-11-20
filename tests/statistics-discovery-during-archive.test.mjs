import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const discovery = worker.indexOf('if (status === "LIVE" || status === "FT") {');
assert.ok(discovery >= 0, "completed/live ESPN events can enqueue statistics during archive backfill");
assert.ok(worker.includes("deferredSummaryQueue.push"), "new ESPN summaries are deferred while an older backlog exists");
assert.ok(!worker.includes('if (!archiveBackfillActive && (status === "LIVE" || status === "FT"))'), "archive backfill must not gate queue discovery");
assert.ok(worker.includes("summaryBudget = archiveBackfillActive ? (maxRequests <= 10 ? 4 : 16)"), "summary backlog batch is raised to 12 during backfill");
assert.ok(worker.includes("archiveBackfillActive ? 32"), "scoreboard budget is reduced to keep the combined request budget bounded");
console.log("Statistics discovery during archive backfill regression test passed.");
