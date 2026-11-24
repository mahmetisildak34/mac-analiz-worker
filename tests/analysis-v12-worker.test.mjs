import assert from "node:assert/strict";
import { test } from "node:test";
import { calculatePrematchV12 } from "../analysis-v1-2.mjs";

const allHome = { count: 10, gf: 1.6, ga: 1.1, halfCount: 5, firstGF: 0.8, firstGA: 0.4, secondGF: 0.8, secondGA: 0.7, firstBothRate: 0.3, secondBothRate: 0.4 };
const allAway = { count: 10, gf: 1.2, ga: 1.4, halfCount: 5, firstGF: 0.5, firstGA: 0.7, secondGF: 0.7, secondGA: 0.7, firstBothRate: 0.2, secondBothRate: 0.2 };
const venueHome = { ...allHome, count: 4, gf: 2, ga: 0.8 };
const venueAway = { ...allAway, count: 4, gf: 0.9, ga: 1.7 };

test("Worker calculation retains Poisson v1.2 venue fallback and bounded lambdas", () => {
  const result = calculatePrematchV12({ homeOverall: allHome, awayOverall: allAway, homeVenue: venueHome, awayVenue: venueAway, homeName: "Home", awayName: "Away" });
  assert.equal(result.model, "poisson-v1.2");
  assert.equal(result.homeVenueFallback, false);
  assert.equal(result.awayVenueFallback, false);
  assert.equal(result.lambdaHome, 1.85);
  assert.ok(Math.abs(result.lambdaAway - 0.85) < 1e-12);
  assert.ok(Math.abs(result.homeWin + result.draw + result.awayWin - 1) < 0.002);
  assert.equal(result.topScores.length, 5);
  assert.ok(result.topScores[0].p >= result.topScores[1].p);
});

test("venue sample below three falls back to overall statistics exactly as v1.2", () => {
  const result = calculatePrematchV12({ homeOverall: allHome, awayOverall: allAway, homeVenue: { ...venueHome, count: 2 }, awayVenue: { ...venueAway, count: 2 }, homeName: "Home", awayName: "Away" });
  assert.equal(result.homeVenueFallback, true);
  assert.equal(result.awayVenueFallback, true);
  assert.equal(result.lambdaHome, (allHome.gf + allAway.ga) / 2);
  assert.equal(result.lambdaAway, (allAway.gf + allHome.ga) / 2);
});

test("insufficient history refuses to create a premium result", () => {
  assert.throws(() => calculatePrematchV12({ homeOverall: { ...allHome, count: 9 }, awayOverall: allAway, homeVenue: venueHome, awayVenue: venueAway }), /Insufficient verified match history/);
});
