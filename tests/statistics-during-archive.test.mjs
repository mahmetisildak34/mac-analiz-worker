import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
assert.match(worker, /summaryBudget = archiveBackfillActive \? \(maxRequests <= 10 \? 4 : 8\)/, "archive backfill reserves bounded statistics budget");
assert.match(worker, /scoreboardBudget = effectiveMaxRequests <= 10 \? 10 : \(archiveBackfillActive \? 40/, "archive scoreboard budget is reduced to balance requests");
console.log("statistics-during-archive regression test passed");
