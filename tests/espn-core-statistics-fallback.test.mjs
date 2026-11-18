import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const summaryStart = worker.indexOf("const response = await fetch(ESPN_BASE + \"/\" + item.slug + \"/summary?event=\"");
const summaryEnd = worker.indexOf("if (summaryRetries.length) summaryQueue.push(...summaryRetries);", summaryStart);
assert.ok(summaryStart >= 0 && summaryEnd > summaryStart, "summary fetch processing block exists");
const summaryBlock = worker.slice(summaryStart, summaryEnd);
assert.ok(summaryBlock.includes("sports.core.api.espn.com/v2/sports/soccer/leagues/"), "Core API fallback exists");
assert.ok(summaryBlock.includes("/competitors/\" + encodeURIComponent(teamId) + \"/statistics"), "fallback fetches team-level stats");
assert.ok(summaryBlock.includes("payload?.header?.competitions?.[0]?.competitors"), "competitor IDs extracted from summary header");
assert.ok(summaryBlock.includes("coreResults.filter(Boolean).length === 2"), "requires both teams to have stats");
assert.ok(summaryBlock.includes('statisticsSource: "ESPN summary/core"'), "fallback source is recorded");
assert.ok(summaryBlock.includes("retryAfter: Date.now() + 24 * 60 * 60 * 1000"), "no-statistics events are cooled down");
console.log("ESPN Core API team-statistics fallback regression checks passed.");
