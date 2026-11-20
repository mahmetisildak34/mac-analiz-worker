import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const start = worker.indexOf('if (path === "archive/d1-status")');
assert.ok(start >= 0, "D1 status endpoint must exist");
const end = worker.indexOf('if (path === "superlig/fixtures")', start);
assert.ok(end > start, "D1 status endpoint block boundary must exist");
const block = worker.slice(start, end);

assert.ok(block.includes('const cachedD1Status = env.MAM_KV ? await env.MAM_KV.get(d1StatusCacheKey) : null'), "all requests must use KV cache; fresh=1 must not bypass it");
assert.ok(!block.includes("forceFreshD1Status"), "fresh=1 bypass must be removed to protect D1 read quota");
assert.ok(block.includes('mam:d1-status-cache-persisted:v1'), "a live cached snapshot must be persisted without a six-hour expiry");
assert.ok(!block.includes("env.DB.prepare("), "a cache miss must never run aggregate D1 scans");
assert.ok(block.includes('status: "cached-snapshot-unavailable"'), "cache miss must fail closed with an explicit status");
assert.ok(block.includes('env.MAM_KV.get("mam:espn-summary-queue:v1", "json")'), "live queue telemetry must refresh from KV without D1 reads");
assert.ok(block.includes('env.MAM_KV.get("mam:espn-summary-last-run:v1", "json")'), "last summary run must refresh from KV without D1 reads");
assert.ok(block.includes("report.liveStatusUpdatedAt = new Date().toISOString()"), "cached aggregate response must include live status refresh timestamp");
assert.ok(block.includes('env.MAM_KV.get("mam:cross-source-stats:last:v4", "json")'), "status must read the current cross-source report version v4");
console.log("D1 status cache fail-closed regression tests passed.");
