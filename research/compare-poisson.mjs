import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { predictTrustedGoals } from '../trusted-goal-poisson.js';
import { estimateRates, exactScoreProbability, fitRho, scoreGrid } from './poisson-v14.mjs';

const versions = ['1.2', '1.3', '1.4'];
const outcomes = ['home', 'draw', 'away'];
const binary = ['btts', 'over15', 'over25', 'over35'];
const configurations = [5, 10, 20].flatMap(window =>
  [45, 90, 180].map(halfLifeDays => ({ window, halfLifeDays })));
const partitions = {
  tune: '2025-01-01',
  calibration: '2025-08-01',
  test: '2026-01-01'
};
// The pinned Süper Lig source ends on 2025-11-03. Its earlier holdout stays separate.
const leagueTestStarts = { 'tr.1': '2025-10-01' };
const cutoffOf = kickoff => new Date(Date.parse(kickoff) - 86400000).toISOString();
const loss = p => -Math.log(Math.max(1e-15, p));
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const result = (home, away) => home > away ? 'home' : home < away ? 'away' : 'draw';
const periodGoals = (match, period) => period === 'full'
  ? [match.home_goals, match.away_goals] : [match.ht_home, match.ht_away];

function independentMarkets(home, away) {
  const total = home + away;
  const zero = Math.exp(-total);
  return {
    over15: 1 - zero * (1 + total),
    over25: 1 - zero * (1 + total + total ** 2 / 2),
    over35: 1 - zero * (1 + total + total ** 2 / 2 + total ** 3 / 6)
  };
}

function independentExact(home, away, homeGoals, awayGoals) {
  const pmf = (rate, goals) => {
    let probability = Math.exp(-rate);
    for (let i = 1; i <= goals; i++) probability *= rate / i;
    return probability;
  };
  return pmf(home, homeGoals) * pmf(away, awayGoals);
}

function baseline(history, target, period, version) {
  const rows = history.flatMap(match => {
    const [home_goals, away_goals] = periodGoals(match, period);
    return home_goals == null || away_goals == null ? [] : [{ ...match, home_goals, away_goals }];
  });
  if (rows.length < 30) return null;
  const prediction = predictTrustedGoals(rows, {
    ...target,
    as_of: target.kickoff,
    model_version: version,
    max_goals: 20,
    league_average_home_goals: average(rows.map(match => match.home_goals)),
    league_average_away_goals: average(rows.map(match => match.away_goals))
  });
  if (!prediction.available) return null;
  const { lambda_home: home, lambda_away: away, probabilities: p } = prediction;
  return {
    home: p.home_win, draw: p.draw, away: p.away_win, btts: p.btts_yes,
    ...independentMarkets(home, away), exact: (h, a) => independentExact(home, away, h, a)
  };
}

function model14(rates, rho) {
  return {
    ...scoreGrid(rates.home, rates.away, rho),
    exact: (h, a) => exactScoreProbability(rates.home, rates.away, rho, h, a)
  };
}

function scored(p, [home, away]) {
  const actual = result(home, away);
  const predicted = outcomes.reduce((a, b) => p[a] >= p[b] ? a : b);
  return {
    brier: outcomes.reduce((sum, key) => sum + (p[key] - Number(key === actual)) ** 2, 0),
    logLoss: loss(p[actual]), correct: Number(predicted === actual), confidence: p[predicted],
    homeProbability: p.home, awayProbability: p.away,
    homeWin: Number(actual === 'home'), awayWin: Number(actual === 'away'),
    exactLogLoss: loss(p.exact(home, away)),
    binary: Object.fromEntries(binary.map((key, i) => {
      const observed = i === 0 ? home > 0 && away > 0 : home + away >= i + 1;
      return [key, (p[key] - Number(observed)) ** 2];
    }))
  };
}

function summarize(rows) {
  if (!rows.length) return { matches: 0 };
  const metric = key => average(rows.map(row => row[key]));
  const binErrors = Array(10).fill(0);
  for (const row of rows) binErrors[Math.min(9, Math.floor(row.confidence * 10))] += row.confidence - row.correct;
  return {
    matches: rows.length, brier: metric('brier'), logLoss: metric('logLoss'),
    ece: binErrors.reduce((sum, error) => sum + Math.abs(error), 0) / rows.length,
    accuracy: metric('correct'), exactLogLoss: metric('exactLogLoss'),
    homeWin: { predicted: metric('homeProbability'), observed: metric('homeWin') },
    awayWin: { predicted: metric('awayProbability'), observed: metric('awayWin') },
    binaryBrier: Object.fromEntries(binary.map(key => [key, average(rows.map(row => row.binary[key]))]))
  };
}

// Data quality bins use venue coverage only for this single-source dataset.
// Cut points are selected on calibration data and frozen before the test period.
function calibrate(rows) {
  const candidates = [];
  for (const low of [8, 12, 16]) {
    for (const high of [18, 22, 26]) {
      const bins = partitionReliability(rows, { low, high });
      if (Object.values(bins).some(bin => bin.matches < 50) ||
          !(bins.low.logLoss >= bins.medium.logLoss && bins.medium.logLoss >= bins.high.logLoss)) continue;
      candidates.push({ low, high, separation: bins.low.logLoss - bins.high.logLoss });
    }
  }
  return candidates.sort((a, b) => b.separation - a.separation)[0] ?? null;
}

function partitionReliability(rows, { low, high }) {
  return Object.fromEntries(['low', 'medium', 'high'].map((level, i) => [
    level, summarize(rows.filter(row => row.sample < low ? i === 0 : row.sample < high ? i === 1 : i === 2))
  ]));
}

function compareLeague(rows, period, testStart) {
  const examples = rows.flatMap(match => {
    const actual = periodGoals(match, period);
    if (actual.some(goal => goal == null)) return [];
    const target = { ...match, kickoff: cutoffOf(match.kickoff) };
    const history = rows.filter(row => Date.parse(row.kickoff) < Date.parse(target.kickoff));
    return [{
      match, actual,
      rates: configurations.map(options => estimateRates(history, target, { ...options, period })),
      baselines: match.kickoff >= partitions.calibration
        ? versions.slice(0, 2).map(version => baseline(history, target, period, version)) : []
    }];
  });
  const early = examples.filter(row => row.match.kickoff < partitions.tune);
  const tune = examples.filter(row => row.match.kickoff >= partitions.tune &&
    row.match.kickoff < partitions.calibration && row.rates.every(Boolean));
  const fit = (data, index, cutoff) => fitRho(data.flatMap(({ match, rates, actual }) => rates[index] ? [{
    ...rates[index], kickoff: match.kickoff, fixtureId: match.fixture_id,
    homeGoals: actual[0], awayGoals: actual[1]
  }] : []), cutoff);
  const candidates = configurations.map((options, index) => {
    const rho = fit(early, index, partitions.tune);
    return { ...options, index, rho, tuneLogLoss: rho == null ? null :
      average(tune.map(row => loss(model14(row.rates[index], rho)[result(...row.actual)]))) };
  });
  const selected = candidates.filter(option => option.tuneLogLoss != null)
    .sort((a, b) => a.tuneLogLoss - b.tuneLogLoss)[0];
  if (!selected) return { candidates, available: false };
  const rho = fit(examples.filter(row => row.match.kickoff < partitions.calibration),
    selected.index, partitions.calibration);
  const cohorts = { calibration: [], test: [] };
  for (const row of examples) {
    if (row.match.kickoff < partitions.calibration || !row.baselines.every(Boolean) ||
        !row.rates[selected.index] || rho == null) continue;
    const rates = row.rates[selected.index];
    const predictions = [...row.baselines, model14(rates, rho)];
    const cohort = row.match.kickoff < testStart ? 'calibration' : 'test';
    cohorts[cohort].push({
      values: predictions.map(p => scored(p, row.actual)),
      sample: Math.min(rates.homeVenueHistory, rates.awayVenueHistory)
    });
  }
  return {
    candidates, selected: { ...selected, rho },
    testStart,
    testEligible: examples.filter(row => row.match.kickoff >= testStart).length,
    cohorts
  };
}

export function compareArchive({ sources, leagues }) {
  const byLeague = Object.fromEntries(Object.entries(leagues).map(([id, rows]) => [
    id, Object.fromEntries(['full', 'half'].map(period => [period, compareLeague(rows, period, leagueTestStarts[id] ?? partitions.test)]))
  ]));
  const aggregate = {};
  for (const period of ['full', 'half']) {
    const cohort = key => Object.values(byLeague).flatMap(league =>
      league[period].testStart === partitions.test ? league[period].cohorts?.[key] ?? [] : []);
    // Calibrate for the default model. Levels describe archive quality, not match odds.
    const data = key => cohort(key).map(row => ({ ...row.values[0], sample: row.sample }));
    const thresholds = calibrate(data('calibration'));
    const testReliability = thresholds ? partitionReliability(data('test'), thresholds) : null;
    const validated = Boolean(testReliability && Object.values(testReliability).every(bin => bin.matches >= 50) &&
      testReliability.low.logLoss >= testReliability.medium.logLoss &&
      testReliability.medium.logLoss >= testReliability.high.logLoss);
    aggregate[period] = {
      models: Object.fromEntries(versions.map((version, i) => [
        version, summarize(cohort('test').map(row => row.values[i]))
      ])),
      reliability: {
        thresholds, validated,
        calibration: thresholds ? partitionReliability(data('calibration'), thresholds) : null,
        test: testReliability
      }
    };
  }
  for (const league of Object.values(byLeague)) {
    for (const period of Object.values(league)) {
      if (!period.cohorts) continue;
      period.models = Object.fromEntries(versions.map((version, i) => [
        version, summarize(period.cohorts.test.map(row => row.values[i]))
      ]));
      delete period.cohorts;
    }
  }
  return { sources, partitions, aggregate, leagues: byLeague };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const report = compareArchive(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  console.log(JSON.stringify(report, null, 2));
}
