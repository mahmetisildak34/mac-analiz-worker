import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const summaryStart = worker.indexOf("const summaryRun =");
const summaryEnd = worker.indexOf("const summaryRetries", summaryStart);
assert.ok(summaryStart >= 0 && summaryEnd > summaryStart, "summary processing block exists");
const block = worker.slice(summaryStart, summaryEnd);
const updateAt = block.indexOf("UPDATE matches SET statistics_json");
assert.ok(updateAt >= 0, "summary statistics update exists");
const sql = block.slice(updateAt, block.indexOf("\n", updateAt));
assert.ok(sql.includes("WHERE source = 'ESPN' AND fixture_id = ?"), "update is scoped to ESPN fixture");
assert.ok(sql.includes("statistics_json IS NULL"), "empty statistics can be filled");
assert.ok(sql.includes("json_valid(statistics_json) = 0"), "malformed statistics can be repaired");
assert.ok(sql.includes("json_array_length(json_extract(statistics_json, '$.teams[0].statistics'))"), "empty home statistics can be repaired");
assert.ok(sql.includes("json_array_length(json_extract(statistics_json, '$.teams[1].statistics'))"), "empty away statistics can be repaired");
assert.ok(sql.includes("statistics_json = 'null'"), "literal null can be repaired");
console.log("ESPN summary overwrite guard regression test passed.");
