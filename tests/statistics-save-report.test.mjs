import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const summaryStart = worker.indexOf("const summaryRun =");
const summaryEnd = worker.indexOf("const doneList = Array.from(summaryDoneSet);", summaryStart);
assert.ok(summaryStart >= 0 && summaryEnd > summaryStart, "summary processing block exists");
const block = worker.slice(summaryStart, summaryEnd);

assert.match(block, /const pendingChanges = Number\(pendingWriteResult\?\.meta\?\.changes \|\| 0\);/, "pending D1 writes read actual row changes");
assert.match(block, /summaryRun\.saved \+= pendingChanges;/, "pending saved count increments only by actual row changes");
assert.match(block, /const actualChanges = Number\(statisticsWriteResult\?\.meta\?\.changes \|\| 0\);/, "statistics D1 writes read actual row changes");
assert.match(block, /summaryRun\.saved \+= actualChanges;/, "fresh saves count only actual row changes");
assert.match(block, /summaryRun\.fetchedWithStatistics\+\+;/, "fetched statistics are tracked separately from saved rows");

console.log("Actual ESPN statistics saved-count regression test passed.");
