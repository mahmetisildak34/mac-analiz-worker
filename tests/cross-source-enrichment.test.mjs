import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const start = worker.indexOf("async function enrichExactCrossSourceMatches");
const end = worker.indexOf("// Safe, additive D1 indexes", start);
assert.ok(start >= 0 && end > start, "cross-source enrichment function exists");
const fn = worker.slice(start, end);

assert.ok(fn.includes('mam:cross-source-scan-cursors:v5'), "date-aligned scan uses a new durable checkpoint without resetting v4");
assert.ok(fn.includes('if (!env.MAM_KV) return'), "scan must pause rather than run without durable checkpoints");
assert.ok(fn.includes("Math.max(1, Math.min(240, Number(options.sourceLimit) || 240))"), "source scan limit is configurable but capped at 240 rows");
assert.ok(fn.includes("Math.max(1, Math.min(120, Number(options.missingLimit) || 120))"), "ESPN scan limit is configurable but capped at 120 rows");
const selectionSql = fn.slice(fn.indexOf("const sourceSql"), fn.indexOf("const sourceRows"));
assert.ok(selectionSql.includes("kickoff >= ? AND kickoff <= ?"), "source rows must be selected in the current missing ESPN date window");
assert.ok(!selectionSql.includes("json_array_length"), "selection queries must not use unbounded JSON predicates");
assert.ok(fn.includes("const sameWindow = sourceState.windowStart === windowStart && sourceState.windowEnd === windowEnd"), "source cursor is reused only for the same target date window");
assert.ok(fn.includes("const validMissingTimes = missing.map(row => Date.parse(row.kickoff || \"\")).filter(Number.isFinite)"), "provider date window must be based only on ESPN rows needing repair");
assert.ok(fn.includes("const sourceBatchDone = sourceRows.length < sourceLimit"), "full source batches must retain their cursor for the next bounded scan");
assert.ok(fn.includes("const advanceMissing = sourceDone && scannedMissingRows.length > 0"), "missing cursor advances only after the provider window is exhausted");
assert.ok(fn.includes("const advanceMissing = sourceDone && scannedMissingRows.length > 0"), "missing cursor advances only after its source date window is exhausted");
assert.ok(fn.includes("await env.MAM_KV.put(cursorKey, JSON.stringify(nextCursors))"), "cursor checkpoint must persist without expiry");
assert.ok(fn.includes("candidate.delta <= 6 * 60 * 60 * 1000"), "kickoff tolerance stays at six hours");
assert.ok(fn.includes("candidate.sameCountry && candidate.sameLeague"), "competition context is checked");
assert.ok(fn.includes("Number(row.home_goals) === Number(candidate.homeGoals)"), "home score must match");
assert.ok(fn.includes("Number(row.away_goals) === Number(candidate.awayGoals)"), "away score must match");
assert.ok(fn.includes("safeCandidates[1].delta - safeCandidates[0].delta < 30 * 60 * 1000"), "near-tied candidates are rejected as ambiguous");
assert.ok(fn.includes("WHERE source = 'ESPN' AND fixture_id = ? AND"), "only incomplete target ESPN rows can be updated");
assert.ok(fn.includes("updates.slice(i, i + 25)"), "writes are bounded in batches of 25");
assert.ok(fn.includes("sourceRowsScanned: sourceRows.length"), "source scan count is reported");
assert.ok(fn.includes("sourcePayloadDiagnostics"), "bounded provider payload shape diagnostics are reported");
assert.ok(fn.includes("normalizerAccepted++"), "successful source payload normalization is counted");
assert.ok(fn.includes("normalizerRejected++"), "rejected source payload normalization is counted");
assert.ok(fn.includes("topLevelKeySamples"), "top-level source JSON keys are sampled");
assert.ok(fn.includes("teamObjectKeySamples"), "team JSON object keys are sampled");
assert.ok(fn.includes("homeAwayObjectKeySamples"), "nested home/away object keys are sampled");
assert.ok(fn.includes("homeAwayValueShapeSamples"), "nested home/away field value shapes are sampled");
assert.ok(fn.includes("const source = sourceRows.filter(row => row.source !== \"ESPN\" && row.statistics_json && row.statistics_json !== \"null\")"), "all non-empty provider payloads reach the normalizer counters");
assert.ok(fn.includes("missingFirstKickoff"), "source and target date ranges are reported");
assert.ok(fn.includes("missingEspnRowsScanned: scannedMissingRows.length"), "ESPN window count is reported");
assert.ok(fn.includes('scanStatus: sourceDone && missingDone ? "scan-complete" : "more-batches-available"'), "scan completion is explicit");
assert.ok(fn.includes("verifiedPersisted"), "writes are verified by reading the target ESPN rows");
assert.ok(fn.includes("SELECT fixture_id, statistics_json FROM matches WHERE source = 'ESPN' AND fixture_id IN"), "persistence verification is bounded to attempted fixture IDs");

const scheduledStart = worker.indexOf('const enrichmentThrottleKey = "mam:cross-source-enrichment-last:v8"');
const scheduledEnd = worker.indexOf("const crossSourceStats = await enrichExactCrossSourceMatches(env)", scheduledStart);
assert.ok(scheduledStart >= 0 && scheduledEnd > scheduledStart, "scheduled enrichment throttle exists");
const scheduledThrottle = worker.slice(scheduledStart, scheduledEnd);
assert.ok(scheduledThrottle.includes("Date.now() - lastEnrichmentAt >= 30 * 60 * 1000"), "successful enrichment batches are throttled to 30 minutes");
assert.ok(worker.includes('await env.MAM_KV.put("mam:cross-source-enrichment-last:v8", String(Date.now()), { expirationTtl: 60 * 60 * 48 })'), "D1/read failures retain the 48-hour backoff checkpoint");


const previewEndpointStart = worker.indexOf('if (path === "archive/cross-source-preview-test" && request.method === "POST")');
assert.ok(previewEndpointStart >= 0, "preview test endpoint exists");
const previewEndpoint = worker.slice(previewEndpointStart, worker.indexOf('if (path === "archive/sync-status"', previewEndpointStart));
assert.ok(previewEndpoint.includes('env.HISTORY_BACKFILL_PILOT_ENABLED !== "true"'), "preview test endpoint is disabled unless preview-only flag is enabled");
assert.ok(previewEndpoint.includes('minKickoff: "2024-01-01T00:00:00.000Z"'), "preview test is restricted to 2024 fixtures");
assert.ok(previewEndpoint.includes('maxKickoff: "2025-01-01T00:00:00.000Z"'), "preview test excludes fixtures from 2025 onward");
assert.ok(previewEndpoint.includes("missingLimit: 20"), "preview ESPN batch is limited to 20 rows");
assert.ok(previewEndpoint.includes("sourceLimit: 40"), "preview provider batch is limited to 40 rows");
assert.ok(previewEndpoint.includes('cursorKey: "mam:cross-source-preview-test:cursors:v1"'), "preview test uses an isolated cursor");
assert.ok(previewEndpoint.includes("reportKey: \"mam:cross-source-preview-test:last:v1\""), "preview report is isolated from scheduled enrichment status");
assert.ok(previewEndpoint.includes('reportKey: "mam:cross-source-preview-test:last:v1"'), "preview test uses an isolated report key");
assert.ok(worker.includes('requestUrl.pathname === "/api/archive/cross-source-preview-test"'), "preview test endpoint is POST-only");

console.log("Cross-source bounded keyset scan regression tests passed.");
