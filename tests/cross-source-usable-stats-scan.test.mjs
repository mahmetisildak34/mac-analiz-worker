import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const start = worker.indexOf("const sourceStatsPredicate =");
const end = worker.indexOf("const missingSql =", start);
assert.ok(start >= 0 && end > start, "cross-source scan has a bounded source query");
const sourceQuery = worker.slice(start, end);
assert.match(sourceQuery, /statistics_json IS NOT NULL/, "NULL statistics rows are excluded in SQL");
assert.match(sourceQuery, /json_valid\(statistics_json\) = 1/, "malformed JSON rows are excluded in SQL");
assert.match(sourceQuery, /json_array_length\(statistics_json, '\$\.teams\[0\]\.statistics'\)/,
  "ESPN-style source rows must contain home-team statistics");
assert.match(sourceQuery, /json_array_length\(statistics_json, '\$\.teams\[1\]\.statistics'\)/,
  "ESPN-style source rows must contain away-team statistics");
assert.match(sourceQuery, /json_type\(statistics_json, '\$\.response'\) = 'array'/,
  "API-Football response arrays remain eligible");
assert.match(sourceQuery, /LIMIT 240/, "the source scan remains bounded");

console.log("Cross-source statistics scan regression test passed.");
