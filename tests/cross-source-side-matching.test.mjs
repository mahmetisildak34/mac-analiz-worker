import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const start = worker.indexOf("const normalizeCrossSourceStatistics =");
const end = worker.indexOf("\n  };\n\n  const statsIndex", start);
assert.ok(start >= 0 && end > start, "cross-source normalizer exists");
const source = worker.slice(start, end + 5)
  .replace("const normalizeCrossSourceStatistics =", "globalThis.normalizeCrossSourceStatistics =");
const sandbox = {
  normalizeTeamName: value => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
};
runInNewContext(source, sandbox);

const stats = [
  { homeAway: "home", team: { name: "Inter" }, statistics: [{ name: "shots", value: 8 }] },
  { homeAway: "away", team: { name: "Juventus FC" }, statistics: [{ name: "shots", value: 4 }] }
];
const result = sandbox.normalizeCrossSourceStatistics(
  JSON.stringify({ teams: stats }), "Inter Milan", "Juventus"
);
assert.ok(result, "explicit home/away metadata should allow provider display-name variants");
assert.equal(result.teams[0].homeAway, "home");
assert.equal(result.teams[1].homeAway, "away");

const reversed = [
  { homeAway: "home", team: { name: "Juventus" }, statistics: [{ name: "shots", value: 4 }] },
  { homeAway: "away", team: { name: "Inter" }, statistics: [{ name: "shots", value: 8 }] }
];
assert.equal(
  sandbox.normalizeCrossSourceStatistics(JSON.stringify({ teams: reversed }), "Inter", "Juventus"),
  null,
  "explicitly reversed team names must still be rejected"
);
console.log("Cross-source side-aware team matching tests passed.");
