import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
const start = worker.indexOf('if (path === "archive/upcoming" && request.method === "GET")');
const end = worker.indexOf('if (path === "archive/half-goals" && request.method === "GET")', start);
assert.ok(start >= 0 && end > start, "archive/upcoming route must exist");
const route = worker.slice(start, end);

assert.match(route, /mam:archive-upcoming:v2:/, "query cache key must be versioned");
assert.match(route, /exactDate \|\| "window"/, "cache key separates exact date and rolling window");
assert.match(route, /leagueId \|\| "all"/, "cache key separates league filters");
assert.match(route, /limit, resultsOnly \? "results" : "fixtures"/, "cache key separates limits and result mode");
assert.match(route, /env\.MAM_KV\.get\(upcomingCacheKey\)/, "read cache before D1 query");
assert.ok(route.indexOf("env.MAM_KV.get(upcomingCacheKey)") < route.indexOf("env.DB.prepare("), "KV lookup must precede D1 reads");
assert.match(route, /expirationTtl: exactDate \? 30 : resultsOnly \? 300 : 300/, "exact-date data uses short cache TTL");
assert.match(route, /env\.MAM_KV\.put\(upcomingCacheKey, upcomingResponseBody/, "cache successful response");
assert.match(route, /archive\/upcoming KV cache read failed; falling back to D1/, "cache read failure falls back safely");
assert.match(route, /archive\/upcoming KV cache write failed/, "cache write failure must not block response");
console.log("archive/upcoming KV cache regression test passed");
