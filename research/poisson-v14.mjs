// Experimental only: no production integration.
function validRates(home, away) {
  return [home, away].every(rate => Number.isFinite(rate) && rate > 0 && rate <= 20);
}

function correction(home, away, homeGoals, awayGoals) {
  if (homeGoals === 0 && awayGoals === 0) return -home * away;
  if (homeGoals === 0 && awayGoals === 1) return home;
  if (homeGoals === 1 && awayGoals === 0) return away;
  if (homeGoals === 1 && awayGoals === 1) return -1;
  return 0;
}

function poisson(rate, maxGoals) {
  const probabilities = [Math.exp(-rate)];
  for (let goal = 1; goal <= maxGoals; goal++) {
    probabilities.push(probabilities[goal - 1] * rate / goal);
  }
  return probabilities;
}

export function scoreGrid(home, away, rho = 0) {
  if (!validRates(home, away)) throw new RangeError('Invalid rates');
  if (!Number.isFinite(rho) || rho < Math.max(-1 / home, -1 / away) ||
      rho > Math.min(1, 1 / (home * away))) throw new RangeError('Invalid rho');

  const homeGoals = poisson(home, 100);
  const awayGoals = poisson(away, 100);
  const markets = { home: 0, draw: 0, away: 0, btts: 0, over15: 0, over25: 0, over35: 0 };
  let total = 0;
  for (let i = 0; i < homeGoals.length; i++) {
    for (let j = 0; j < awayGoals.length; j++) {
      const p = homeGoals[i] * awayGoals[j] * (1 + rho * correction(home, away, i, j));
      total += p;
      markets[i > j ? 'home' : i === j ? 'draw' : 'away'] += p;
      if (i > 0 && j > 0) markets.btts += p;
      if (i + j >= 2) markets.over15 += p;
      if (i + j >= 3) markets.over25 += p;
      if (i + j >= 4) markets.over35 += p;
    }
  }
  for (const key of Object.keys(markets)) markets[key] /= total;
  return markets;
}

export function exactScoreProbability(home, away, rho, homeGoals, awayGoals) {
  if (homeGoals == null || awayGoals == null) return null;
  if (![homeGoals, awayGoals].every(value => Number.isSafeInteger(value) && value >= 0)) throw new RangeError('Invalid exact score');
  if (!validRates(home, away) || !Number.isFinite(rho) ||
      rho < Math.max(-1 / home, -1 / away) || rho > Math.min(1, 1 / (home * away))) {
    throw new RangeError('Invalid model parameters');
  }
  // Above 100 goals the probability mass is negligible for the supported rates.
  if (homeGoals > 100 || awayGoals > 100) return 0;
  return poisson(home, homeGoals)[homeGoals] * poisson(away, awayGoals)[awayGoals] *
    (1 + rho * correction(home, away, homeGoals, awayGoals));
}

// Fit on out-of-sample training predictions produced before each training kickoff.
export function fitRho(training, asOf) {
  const cutoff = Date.parse(asOf);
  if (!Number.isFinite(cutoff) || !Array.isArray(training)) return null;

  const seen = new Set();
  const coefficients = [];
  for (const row of training) {
    if (!(Date.parse(row?.kickoff) < cutoff) || !row.fixtureId || seen.has(row.fixtureId) ||
        !validRates(row.home, row.away) ||
        ![row.homeGoals, row.awayGoals].every(value => Number.isSafeInteger(value) && value >= 0)) {
      return null;
    }
    seen.add(row.fixtureId);
    coefficients.push(correction(row.home, row.away, row.homeGoals, row.awayGoals));
  }
  if (coefficients.filter(coefficient => coefficient !== 0).length < 20) return null;

  // A common interval keeps each low-score multiplier positive at all supported rates.
  let lower = -0.0499;
  let upper = 0.00249;
  for (let i = 0; i < 48; i++) {
    const rho = (lower + upper) / 2;
    const slope = coefficients.reduce((sum, value) => sum + value / (1 + rho * value), 0);
    if (slope > 0) lower = rho;
    else upper = rho;
  }
  return (lower + upper) / 2;
}

// Input is a single league's verified archive in the trusted-goal model format.
export function estimateRates(rows, target, { window = 10, halfLifeDays = 90, period = 'full' } = {}) {
  const cutoff = Date.parse(target?.kickoff);
  if (!Number.isFinite(cutoff) || !target.home_team || !target.away_team ||
      target.home_team === target.away_team || !Array.isArray(rows) ||
      ![5, 10, 20].includes(window) || !Number.isFinite(halfLifeDays) ||
      halfLifeDays <= 0 || !['full', 'half'].includes(period)) return null;

  const valid = goals => Number.isInteger(goals) && goals >= 0;
  const fixtures = new Map();
  const conflicts = new Set();
  for (const row of rows) {
    const kickoff = Date.parse(row?.kickoff);
    if (!(kickoff < cutoff) || row.identity_verified !== true || row.score_verified !== true ||
        row.completed !== true || row.conflicting === true || row.status !== 'FT' ||
        !row.home_team || !row.away_team || row.home_team === row.away_team ||
        !valid(row.home_goals) || !valid(row.away_goals)) continue;

    const home = period === 'full' ? row.home_goals : row.ht_home;
    const away = period === 'full' ? row.away_goals : row.ht_away;
    if (!valid(home) || !valid(away) || home > row.home_goals || away > row.away_goals) continue;
    const key = JSON.stringify([kickoff, row.home_team, row.away_team]);
    const prior = fixtures.get(key);
    if (prior && (prior.home !== home || prior.away !== away ||
        prior.homeFinal !== row.home_goals || prior.awayFinal !== row.away_goals)) conflicts.add(key);
    fixtures.set(key, { ...row, kickoff, home, away, homeFinal: row.home_goals, awayFinal: row.away_goals });
  }
  for (const key of conflicts) fixtures.delete(key);
  const history = [...fixtures.values()].sort((a, b) => b.kickoff - a.kickoff);
  if (history.length < 20) return null;

  const average = side => history.reduce((sum, row) => sum + row[side], 0) / history.length;
  const homeAverage = average('home');
  const awayAverage = average('away');
  if (homeAverage <= 0 || awayAverage <= 0) return null;

  function strength(team, side, other, scoringAverage, concedingAverage) {
    const venueHistory = history.filter(row => row[side + '_team'] === team);
    const sample = venueHistory.slice(0, window);
    if (sample.length < 3) return null;
    let weight = 0;
    let scored = 0;
    let conceded = 0;
    for (const row of sample) {
      const recency = 2 ** (-(cutoff - row.kickoff) / (86400000 * halfLifeDays));
      weight += recency;
      scored += recency * row[side];
      conceded += recency * row[other];
    }
    // Five league-average pseudo-matches shrink weak venue samples toward the baseline.
    return {
      count: sample.length,
      total: venueHistory.length,
      attack: (scored / scoringAverage + 5) / (weight + 5),
      defense: (conceded / concedingAverage + 5) / (weight + 5)
    };
  }

  const home = strength(target.home_team, 'home', 'away', homeAverage, awayAverage);
  const away = strength(target.away_team, 'away', 'home', awayAverage, homeAverage);
  if (!home || !away) return null;
  return {
    home: Math.min(20, homeAverage * home.attack * away.defense),
    away: Math.min(20, awayAverage * away.attack * home.defense),
    homeSample: home.count,
    homeVenueHistory: home.total,
    awaySample: away.count,
    awayVenueHistory: away.total,
    leagueSample: history.length,
    excludedConflicts: conflicts.size
  };
}
