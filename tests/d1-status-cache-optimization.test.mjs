import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const start = worker.indexOf('if (path === "archive/d1-status")');
assert.ok(start >= 0, "D1 status endpoint must exist");
const end = worker.indexOf('if (path === "archive/', start + 10);
assert.ok(end > start, "D1 status endpoint block boundary must exist");
const block = worker.slice(start, end);

assert.ok(block.includes('const cachedD1Status = env.MAM_KV ? await env.MAM_KV.get(d1StatusCacheKey) : null'), "all requests must use KV cache; fresh=1 must not bypass it");
assert.ok(!block.includes("forceFreshD1Status"), "fresh=1 bypass must be removed to protect D1 read quota");
assert.ok(block.includes('expirationTtl: 6 * 60 * 60'), "D1 status cache should last six hours to reduce repeated aggregate reads");
console.log("D1 status cache optimization regression tests passed.");
