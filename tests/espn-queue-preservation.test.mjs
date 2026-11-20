import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
assert.match(worker, /mam:espn-summary-queue-backup:v1/, "primary queue has a backup key");
assert.match(worker, /mam:espn-summary-deferred-backup:v1/, "deferred queue has a backup key");
assert.match(worker, /if \(Array\.isArray\(backup\)\) return backup/, "missing or malformed queue can recover from backup");
assert.match(worker, /Refusing to overwrite malformed ESPN queue/, "malformed queue fails closed instead of becoming empty");
assert.match(worker, /Refusing to initialize missing ESPN queue without a valid backup/, "missing queue and backup fail closed instead of initializing empty");
assert.match(worker, /summaryQueueBeforeRun = summaryQueue\.slice\(\)/, "previous primary queue snapshot is preserved");
assert.match(worker, /deferredQueueBeforeRun = deferredSummaryQueue\.slice\(\)/, "previous deferred queue snapshot is preserved");
assert.match(worker, /put\(summaryQueueBackupKey, JSON\.stringify\(summaryQueueBeforeRun\)/, "primary snapshot is stored before active queue replacement");
assert.match(worker, /put\(deferredSummaryQueueBackupKey, JSON\.stringify\(deferredQueueBeforeRun\)/, "deferred snapshot is stored before active queue replacement");

console.log("ESPN queue preservation regression test passed.");
