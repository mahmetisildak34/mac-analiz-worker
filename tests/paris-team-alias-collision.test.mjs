import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import bIdentity from "../b-team-identity-registry.cjs";

const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const start = worker.indexOf("const TEAM_NAME_ALIASES");
const end = worker.indexOf("const ESPN_LEAGUE_COUNTRIES", start);
assert.ok(start >= 0 && end > start, "team aliases and normalizer exist");

const normalizationSource = worker.slice(start, end) + "; globalThis.normalize = normalizeTeamName;";
const sandbox = { bIdentity };
runInNewContext(normalizationSource, sandbox);

assert.equal(sandbox.normalize("PSG"), "paris-saint-germain");
assert.equal(sandbox.normalize("Paris Saint-Germain"), "paris-saint-germain");
assert.equal(sandbox.normalize("Paris FC"), "paris", "Paris FC must not be normalized to PSG");
assert.notEqual(sandbox.normalize("Paris FC"), sandbox.normalize("PSG"), "ambiguous Paris short-name collision is prevented");
console.log("Paris FC / PSG alias collision regression tests passed.");
