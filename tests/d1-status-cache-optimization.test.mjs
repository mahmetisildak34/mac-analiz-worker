import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const start = worker.indexOf('if (path === "archive/d1-status")');
assert.ok(start >= 0, "D1 status endpoint must exist");
const end = worker.indexOf('if (path === "archive/', start + 10);
assert.ok(end > start, "D1 status endpoint block boundary must exist");
const block = worker.slice(start, end);

assert.ok(block.includes('const forceFreshD1Status = url.searchParams.get("fresh") === "1";'), "fresh=1 must explicitly bypass the cache");
assert.ok(block.includes('env.MAM_KV && !forceFreshD1Status ? await env.MAM_KV.get(d1StatusCacheKey) : null'), "default requests must use KV cache");
assert.ok(block.includes('expirationTtl: 6 * 60 * 60'), "D1 status cache should last six hours to reduce repeated aggregate reads");
console.log("D1 status cache optimization regression tests passed.");
