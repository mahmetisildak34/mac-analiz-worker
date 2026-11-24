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

const clampLambda = value => Math.max(0.15, Math.min(4, value));

export function calculatePrematchV12(input) {
  const { homeOverall, awayOverall, homeVenue, awayVenue, homeName, awayName, corners = {} } = input || {};
  for (const stats of [homeOverall, awayOverall, homeVenue, awayVenue]) {
    if (!stats || !Number.isFinite(Number(stats.count)) || !Number.isFinite(Number(stats.gf)) || !Number.isFinite(Number(stats.ga))) {
      throw new TypeError("Invalid match-analysis statistics");
    }
  }
  if (Number(homeOverall.count) < 10 || Number(awayOverall.count) < 10) throw new RangeError("Insufficient verified match history");
  const homeVenueFallback = Number(homeVenue.count) < 3;
  const awayVenueFallback = Number(awayVenue.count) < 3;
  const hs = homeVenueFallback ? homeOverall : homeVenue;
  const as = awayVenueFallback ? awayOverall : awayVenue;
  const lowSample = Number(hs.count) < 5 || Number(as.count) < 5;
  const lambdaHome = clampLambda((Number(hs.gf) + Number(as.ga)) / 2);
  const lambdaAway = clampLambda((Number(as.gf) + Number(hs.ga)) / 2);
  let homeWin = 0, draw = 0, awayWin = 0;
  for (let h = 0; h <= 10; h++) for (let a = 0; a <= 10; a++) {
    const p = poisson(lambdaHome, h) * poisson(lambdaAway, a);
    if (h > a) homeWin += p; else if (h === a) draw += p; else awayWin += p;
  }
  const total = lambdaHome + lambdaAway;
  const hasHalf = Number(hs.halfCount || 0) >= 3 && Number(as.halfCount || 0) >= 3;
  let first05 = null, first15 = null, second05 = null, second15 = null;
  let firstBttsYes = null, secondBttsYes = null;
  if (hasHalf) {
    const firstLambda = Math.max(0.1, (Number(hs.firstGF) + Number(as.firstGA) + Number(as.firstGF) + Number(hs.firstGA)) / 2);
    const secondLambda = Math.max(0.1, (Number(hs.secondGF) + Number(as.secondGA) + Number(as.secondGF) + Number(hs.secondGA)) / 2);
    first05 = overProbability(firstLambda, 1);
    first15 = overProbability(firstLambda, 2);
    second05 = overProbability(secondLambda, 1);
    second15 = overProbability(secondLambda, 2);
    firstBttsYes = (Number(hs.firstBothRate || 0) + Number(as.firstBothRate || 0)) / 2;
    secondBttsYes = (Number(hs.secondBothRate || 0) + Number(as.secondBothRate || 0)) / 2;
  }
  const topScores = [];
  for (let h = 0; h <= 7; h++) for (let a = 0; a <= 7; a++) topScores.push({ h, a, p: poisson(lambdaHome, h) * poisson(lambdaAway, a) });
  topScores.sort((a, b) => b.p - a.p);
  const hc = { count: Number(corners.home?.count || 0), average: Number(corners.home?.average || 0) };
  const ac = { count: Number(corners.away?.count || 0), average: Number(corners.away?.average || 0) };
  const expectedCorners = hc.count >= 3 && ac.count >= 3 ? hc.average + ac.average : null;
  const outcome = homeWin >= draw && homeWin >= awayWin
    ? { label: `${homeName} kazanır`, chance: homeWin }
    : draw >= homeWin && draw >= awayWin
      ? { label: "Beraberlik", chance: draw }
      : { label: `${awayName} kazanır`, chance: awayWin };
  return {
    model: "poisson-v1.2", homeName: String(homeName || ""), awayName: String(awayName || ""),
    lambdaHome, lambdaAway, homeWin, draw, awayWin,
    over15: overProbability(total, 2), over25: overProbability(total, 3), over35: overProbability(total, 4),
    btts: (1 - Math.exp(-lambdaHome)) * (1 - Math.exp(-lambdaAway)),
    hasHalf, first05, first15, second05, second15, firstBttsYes, secondBttsYes,
    topScores: topScores.slice(0, 5), outcome, lowSample, homeVenueFallback, awayVenueFallback,
    corners: expectedCorners === null ? null : {
      expected: expectedCorners,
      over85: overProbability(expectedCorners, 9), over95: overProbability(expectedCorners, 10), over105: overProbability(expectedCorners, 11)
    }
  };
}
