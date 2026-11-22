import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { analyzeArchiveResponse } from "../archive-poisson-client.js";

const versions = ["1.2", "1.3"];
const outcomes = ["home_win", "draw", "away_win"];
const dayMs = 24 * 60 * 60 * 1000;
const markets = [...outcomes, "btts_yes", "over_2_5"];

function scorecard() {
  return {
    samples: 0, brier: 0, logLoss: 0,
    bins: Object.fromEntries(markets.map(market => [
      market, Array.from({length: 10}, () => ({n: 0, forecast: 0, observed: 0}))
    ]))
  };
}

function record(card, p, {home, away}) {
  const outcome = home > away ? "home_win" : home < away ? "away_win" : "draw";
  card.samples++;
  card.logLoss -= Math.log(Math.max(1e-15, p[outcome]));
  card.brier += outcomes.reduce((total, key) => total + (p[key] - Number(key === outcome)) ** 2, 0);
  for (const market of markets) {
    const hit = market === "btts_yes" ? home > 0 && away > 0 :
      market === "over_2_5" ? home + away >= 3 : market === outcome;
    const bin = card.bins[market][Math.min(9, Math.floor(p[market] * 10))];
    bin.n++;
    bin.forecast += p[market];
    bin.observed += Number(hit);
  }
}

function summarize(card) {
  const n = card.samples;
  return {
    samples: n, brier: n ? card.brier / n : null, log_loss: n ? card.logLoss / n : null,
    expected_calibration_error: Object.fromEntries(markets.map(market => [
      market, n ? card.bins[market].reduce((sum, bin) => sum + Math.abs(bin.forecast - bin.observed), 0) / n : null
    ]))
  };
}

function verifiedFinal(row) {
  const score = row?.goals;
  return row?.identity_verified === true && row.score_verified === true &&
    row.fixture?.status?.short === "FT" && row.conflicting !== true && Boolean(row.source) &&
    row.fixture.id != null && row.league?.id != null && row.teams?.home?.name && row.teams?.away?.name &&
    Number.isFinite(Date.parse(row.fixture.date)) &&
    [score?.home,score?.away].every(goal => Number.isInteger(goal) && goal >= 0 && goal <= 30);
}

export function backtestCutoff(kickoff) {
  return new Date(Date.parse(kickoff.slice(0, 10) + "T00:00:00Z") - dayMs).toISOString();
}

export function evaluateArchive(rows, maxMatches) {
  const fixtureCounts = new Map();
  const matches = rows.filter(verifiedFinal);
  const key = row => row.league.id + "|" + row.fixture.date.slice(0, 10) + "|" +
    row.teams.home.name + "|" + row.teams.away.name;
  for (const match of matches) fixtureCounts.set(key(match), (fixtureCounts.get(key(match)) ?? 0) + 1);
  const verified = matches.filter(match => fixtureCounts.get(key(match)) === 1);
  const results = {};
  for (const leagueId of new Set(verified.map(row => row.league.id))) {
    const league = verified.filter(row => row.league.id === leagueId);
    const cards = Object.fromEntries(versions.map(version => [version, {full_time: scorecard(), half_time: scorecard()}]));
    for (const match of league) {
      // These season inputs have no reliable publication timestamp. Leave the
      // entire prior calendar day out, including matches crossing midnight.
      const cutoff = backtestCutoff(match.fixture.date);
      const options = {
        home_team: match.teams.home.name, away_team: match.teams.away.name,
        as_of: cutoff, league_id: leagueId, max_matches: maxMatches, max_goals: 20
      };
      const predictions = versions.map(model_version => analyzeArchiveResponse({ok:true,response:league}, {...options, model_version}));
      for (const period of ["full_time", "half_time"]) {
        const actual = period === "full_time" ? match.goals : match.score?.halftime;
        if (!actual || !["home","away"].every(side =>
          Number.isInteger(actual[side]) && actual[side] >= 0 && actual[side] <= match.goals[side]
        ) || !predictions.every(result => result[period].available)) continue;
        versions.forEach((version, index) => record(cards[version][period], predictions[index][period].probabilities, actual));
      }
    }
    results[leagueId] = {
      verified_matches: league.length,
      observed_home_goals: league.reduce((sum, row) => sum + row.goals.home, 0) / league.length,
      observed_away_goals: league.reduce((sum, row) => sum + row.goals.away, 0) / league.length,
      models: Object.fromEntries(versions.map(version => [
        version, Object.fromEntries(Object.entries(cards[version]).map(([period, card]) => [period, summarize(card)]))
      ]))
    };
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2);
  if (files.length === 0) throw new Error("Pass one or more JSON files with provider-verified archive responses.");
  const rows = (await Promise.all(files.map(async file => {
    const data = JSON.parse(await readFile(file, "utf8"));
    const response = Array.isArray(data) ? data : data.response;
    if (!Array.isArray(response)) throw new Error("Invalid archive response: " + file);
    return response;
  }))).flat();
  console.log(JSON.stringify({last_5: evaluateArchive(rows, 5), last_10: evaluateArchive(rows, 10)}, null, 2));
}
