import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const start = worker.indexOf("async function enrichExactCrossSourceMatches");
const end = worker.indexOf("// Safe, additive D1 indexes", start);
assert.ok(start >= 0 && end > start, "cross-source enrichment function exists");
const fn = worker.slice(start, end);

assert.ok(fn.includes("LIMIT 240"), "source scan is batched at 240");
assert.ok(fn.includes("LIMIT 120"), "missing ESPN scan is batched at 120");
assert.ok(fn.includes("candidate.delta <= 6 * 60 * 60 * 1000"), "kickoff tolerance stays at six hours");
assert.ok(fn.includes("candidate.sameCountry && candidate.sameLeague"), "competition context is checked");
assert.ok(fn.includes("Number(row.home_goals) === Number(candidate.homeGoals)"), "home score must match");
assert.ok(fn.includes("Number(row.away_goals) === Number(candidate.awayGoals)"), "away score must match");
assert.ok(fn.includes("safeCandidates[1].delta - safeCandidates[0].delta < 30 * 60 * 1000"), "near-tied candidates are rejected as ambiguous");
assert.ok(fn.includes("WHERE source = 'ESPN' AND fixture_id = ? AND"), "only the target ESPN row is updated");
assert.ok(fn.includes("updates.slice(i, i + 50)"), "writes are batched by 50");
assert.ok(fn.includes("sourceBatchFull: source.length === 240"), "source batch progress is reported");
assert.ok(fn.includes("missingBatchFull: missing.length === 120"), "missing batch progress is reported");
assert.ok(fn.includes("cursorState: nextCursors"), "both cursor states are included in the report");
assert.ok(fn.includes('scanStatus: source.length === 240 || missing.length === 120 ? "more-batches-available" : "batch-scan-complete"'), "report distinguishes ongoing scans from completed batches");
console.log("Cross-source cursor and matching safeguards regression tests passed.");
