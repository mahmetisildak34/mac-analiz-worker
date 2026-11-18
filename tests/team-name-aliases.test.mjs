import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const start = worker.indexOf("const TEAM_NAME_ALIASES");
const end = worker.indexOf("const ESPN_LEAGUE_COUNTRIES", start);
assert.ok(start >= 0 && end > start, "team aliases and normalizer exist");

const normalizationSource = worker.slice(start, end) + "\\nglobalThis.normalize = normalizeTeamName;";
const sandbox = {};
runInNewContext(normalizationSource, sandbox);

const canonical = "istanbul-basaksehir";
for (const variant of [
  "Başakşehir",
  "Basaksehir",
  "Başakşehir FK",
  "Istanbul Basaksehir",
  "İstanbul Başakşehir",
  "Istanbul BB",
  "İstanbul BB",
  "Istanbul Basaksehir FK",
  "Buyuksehyr"
]) {
  assert.equal(sandbox.normalize(variant), canonical, `Expected alias normalization for: ${variant}`);
}
console.log("Istanbul Basaksehir team-name alias regression tests passed.");
