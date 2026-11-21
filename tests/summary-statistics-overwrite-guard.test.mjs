import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const summaryStart = worker.indexOf("const summaryRun =");
const summaryEnd = worker.indexOf("const doneList = Array.from(summaryDoneSet);", summaryStart);
assert.ok(summaryStart >= 0 && summaryEnd > summaryStart, "summary processing block exists");
const block = worker.slice(summaryStart, summaryEnd);
const updateAt = block.indexOf("UPDATE matches SET statistics_json");
assert.ok(updateAt >= 0, "summary statistics update exists");
const sql = block.slice(updateAt, block.indexOf("\n", updateAt));
assert.ok(sql.includes("statistics_json IS NULL"), "only empty statistics can be filled");
assert.ok(sql.includes("TRIM(statistics_json) IN ('','{}','[]','null')"), "valid empty placeholders are eligible");
assert.ok(sql.includes("WHERE source = ? AND fixture_id = ?"), "update is scoped to the exact ESPN source and fixture");
assert.ok(!sql.includes("json_valid(statistics_json) = 0"), "malformed or non-empty existing payloads are not overwritten");
console.log("ESPN summary overwrite guard regression test passed.");
