import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { calculatePrematchV12 } from "../analysis-v1-2.mjs";

// Recorded real ESPN match histories, already used by the app's historical-model browser regression.
const samples = JSON.parse(readFileSync(new URL("./fixtures/espn-poisson-historical-inputs.json", import.meta.url), "utf8"));

function legacyTeamStats(matches, teamId, venue) {
  const valid = (Array.isArray(matches) ? matches : []).filter(match => {
    const home = Number(match.teams?.home?.id) === Number(teamId);
    const away = Number(match.teams?.away?.id) === Number(teamId);
    if ((!home && !away) || (venue === "home" && !home) || (venue === "away" && !away)) return false;
    return Number.isFinite(Number(match.goals?.home)) && Number.isFinite(Number(match.goals?.away)) && match.goals?.home != null && match.goals?.away != null;
  });
  let gf = 0, ga = 0, firstGF = 0, firstGA = 0, secondGF = 0, secondGA = 0;
  let halfCount = 0, firstBoth = 0, secondBoth = 0;
  for (const match of valid) {
    const home = Number(match.teams?.home?.id) === Number(teamId);
    const scored = Number(home ? match.goals.home : match.goals.away);
    const conceded = Number(home ? match.goals.away : match.goals.home);
    gf += scored; ga += conceded;
    const half = match.score?.halftime;
    const htHome = half?.home, htAway = half?.away;
    if (htHome == null || htAway == null || !Number.isFinite(Number(htHome)) || !Number.isFinite(Number(htAway))) continue;
    const ownHalf = Number(home ? htHome : htAway), oppHalf = Number(home ? htAway : htHome);
    const ownSecond = scored - ownHalf, oppSecond = conceded - oppHalf;
    if (ownSecond < 0 || oppSecond < 0) continue;
    halfCount++; firstGF += ownHalf; firstGA += oppHalf; secondGF += ownSecond; secondGA += oppSecond;
    if (ownHalf > 0 && oppHalf > 0) firstBoth++;
    if (ownSecond > 0 && oppSecond > 0) secondBoth++;
  }
  const denominator = valid.length || 1, halfDenominator = halfCount || 1;
  return {
    count: valid.length, gf: gf / denominator, ga: ga / denominator, halfCount,
    firstGF: firstGF / halfDenominator, firstGA: firstGA / halfDenominator,
    secondGF: secondGF / halfDenominator, secondGA: secondGA / halfDenominator,
    firstBothRate: firstBoth / halfDenominator, secondBothRate: secondBoth / halfDenominator
  };
}

// Reference equations below are copied from the unmodified browser implementation on the PR base (main).
function legacyBrowserV12(input) {
  const { homeOverall, awayOverall, homeVenue, awayVenue, homeName, awayName } = input;
  const hs = homeVenue.count < 3 ? homeOverall : homeVenue;
  const as = awayVenue.count < 3 ? awayOverall : awayVenue;
  const lambdaHome = Math.max(.15, Math.min(4, (hs.gf + as.ga) / 2));
  const lambdaAway = Math.max(.15, Math.min(4, (as.gf + hs.ga) / 2));
  const poisson = (lambda, goals) => {
    let probability = Math.exp(-lambda);
    for (let i = 1; i <= goals; i++) probability *= lambda / i;
    return probability;
  };
  const overProbability = (lambda, minimum) => {
    let under = 0;
    for (let i = 0; i < minimum; i++) under += poisson(lambda, i);
    return Math.max(0, Math.min(1, 1 - under));
  };
  let homeWin = 0, draw = 0, awayWin = 0;
  for (let home = 0; home <= 10; home++) for (let away = 0; away <= 10; away++) {
    const probability = poisson(lambdaHome, home) * poisson(lambdaAway, away);
    if (home > away) homeWin += probability;
    else if (home === away) draw += probability;
    else awayWin += probability;
  }
  const total = lambdaHome + lambdaAway;
  const hasHalf = hs.halfCount >= 3 && as.halfCount >= 3;
  let first05 = null, first15 = null, second05 = null, second15 = null;
  if (hasHalf) {
    const firstLambda = Math.max(.1, (hs.firstGF + as.firstGA + as.firstGF + hs.firstGA) / 2);
    const secondLambda = Math.max(.1, (hs.secondGF + as.secondGA + as.secondGF + hs.secondGA) / 2);
    first05 = overProbability(firstLambda, 1); first15 = overProbability(firstLambda, 2);
    second05 = overProbability(secondLambda, 1); second15 = overProbability(secondLambda, 2);
  }
  const topScores = [];
  for (let home = 0; home <= 7; home++) for (let away = 0; away <= 7; away++) topScores.push({ h: home, a: away, p: poisson(lambdaHome, home) * poisson(lambdaAway, away) });
  topScores.sort((a, b) => b.p - a.p);
  const outcome = homeWin >= draw && homeWin >= awayWin
    ? { label: homeName + " kazanır", chance: homeWin }
    : draw >= homeWin && draw >= awayWin ? { label: "Beraberlik", chance: draw } : { label: awayName + " kazanır", chance: awayWin };
  return {
    lambdaHome, lambdaAway, homeWin, draw, awayWin,
    over15: overProbability(total, 2), over25: overProbability(total, 3), over35: overProbability(total, 4),
    btts: (1 - Math.exp(-lambdaHome)) * (1 - Math.exp(-lambdaAway)),
    hasHalf, first05, first15, second05, second15, topScores: topScores.slice(0, 5), outcome,
    lowSample: hs.count < 5 || as.count < 5,
    homeVenueFallback: homeVenue.count < 3, awayVenueFallback: awayVenue.count < 3
  };
}

function modelInput(sample) {
  const [homeId, awayId] = [sample.teams.home.id, sample.teams.away.id];
  const homeHistory = sample.history[String(homeId)], awayHistory = sample.history[String(awayId)];
  const sortRecent = matches => [...matches].sort((a, b) => Date.parse(b.fixture.date) - Date.parse(a.fixture.date)).slice(0, 10);
  const home = sortRecent(homeHistory), away = sortRecent(awayHistory);
  return {
    homeName: sample.teams.home.name, awayName: sample.teams.away.name,
    homeOverall: legacyTeamStats(home, homeId, "all"), awayOverall: legacyTeamStats(away, awayId, "all"),
    homeVenue: legacyTeamStats(home, homeId, "home"), awayVenue: legacyTeamStats(away, awayId, "away"),
    corners: { home: { count: 0, average: 0 }, away: { count: 0, average: 0 } }
  };
}

for (const sample of samples) {
  test(`Worker Poisson v1.2 exactly matches legacy browser results on real ESPN histories: ${sample.teams.home.name} – ${sample.teams.away.name}`, () => {
    const input = modelInput(sample);
    assert.equal(input.homeOverall.count, 10);
    assert.equal(input.awayOverall.count, 10);
    const expected = legacyBrowserV12(input);
    const actual = calculatePrematchV12(input);
    for (const key of ["lambdaHome", "lambdaAway", "homeWin", "draw", "awayWin", "over15", "over25", "over35", "btts", "hasHalf", "first05", "first15", "second05", "second15", "topScores", "outcome", "lowSample", "homeVenueFallback", "awayVenueFallback"]) {
      assert.deepEqual(actual[key], expected[key], `${key} differs for ${sample.teams.home.name} – ${sample.teams.away.name}`);
    }
  });
}

test("Worker model local Node performance and memory sample (not a Cloudflare Worker benchmark)", () => {
  const input = modelInput(samples[0]);
  for (let i = 0; i < 100; i++) calculatePrematchV12(input);
  const before = process.memoryUsage().heapUsed;
  const start = performance.now();
  let checksum = 0;
  for (let i = 0; i < 2000; i++) checksum += calculatePrematchV12(input).homeWin;
  const elapsedMs = performance.now() - start;
  const heapDeltaBytes = process.memoryUsage().heapUsed - before;
  assert.ok(Number.isFinite(checksum));
  console.log(`Poisson v1.2 local Node sample: 2000 runs in ${elapsedMs.toFixed(2)} ms; observed heap delta ${heapDeltaBytes} bytes (not a Cloudflare CPU/memory measurement).`);
});
