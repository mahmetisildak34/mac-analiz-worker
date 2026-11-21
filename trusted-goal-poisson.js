// Evidence-gated, venue-aware Poisson model. No synthetic league baselines or fallback samples.
const norm = value => String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const validScore = value => (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isSafeInteger(Number(value)) && Number(value) >= 0 && Number(value) <= 30;
const finishedStatuses = new Set(["FT", "AET", "PEN", "FINISHED"]);
const poisson = (lambda, goals) => {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= goals; i++) p *= lambda / i;
  return p;
};
const sum = values => values.reduce((total, value) => total + value, 0);
const rate = values => values.length ? sum(values) / values.length : null;

export function predictTrustedGoals(matches, {
  home_team, away_team, as_of, league_average_home_goals, league_average_away_goals,
  min_matches = 5, max_matches = 10, max_goals = 10
} = {}) {
  const counts = { total: Array.isArray(matches) ? matches.length : 0, used: 0, excluded: 0, reasons: {} };
  const exclude = reason => { counts.excluded++; counts.reasons[reason] = (counts.reasons[reason] || 0) + 1; };
  const unavailable = (reason, extra = {}) => ({ available: false, reason, ...counts, ...extra });
  if (!Array.isArray(matches) || !home_team || !away_team || !Number.isFinite(Date.parse(as_of)) ||
      !Number.isSafeInteger(min_matches) || min_matches < 1 ||
      !Number.isSafeInteger(max_matches) || max_matches < min_matches || max_matches > 10 ||
      !Number.isSafeInteger(max_goals) || max_goals < 5 || max_goals > 20) return unavailable("invalid_request");
  const home = norm(home_team), away = norm(away_team);
  if (!home || !away || home === away) return unavailable("invalid_teams");
  const leagueHome = Number(league_average_home_goals), leagueAway = Number(league_average_away_goals);
  if (!Number.isFinite(leagueHome) || leagueHome <= 0 || !Number.isFinite(leagueAway) || leagueAway <= 0) {
    return unavailable("missing_league_averages", { required: ["league_average_home_goals", "league_average_away_goals"] });
  }

  const seen = new Set(), eligibleRows = [], espnGroups = new Map(), homeRows = [], awayRows = [];
  for (const match of matches) {
    if (!match || match.identity_verified !== true) { exclude("identity_not_verified"); continue; }
    if (match.score_verified !== true) { exclude("score_not_verified"); continue; }
    if (match.completed !== true && !finishedStatuses.has(String(match.status || "").toUpperCase())) { exclude("not_confirmed_finished"); continue; }
    if (!match.source || match.fixture_id == null) { exclude("missing_source_identity"); continue; }
    const timestamp = Date.parse(match.kickoff || "");
    if (!Number.isFinite(timestamp) || timestamp >= Date.parse(as_of)) { exclude("invalid_or_future_date"); continue; }
    const homeName = norm(match.home_team), awayName = norm(match.away_team);
    if (!homeName || !awayName || homeName === awayName || match.conflicting === true) { exclude("conflicting_teams"); continue; }
    if (!validScore(match.home_goals) || !validScore(match.away_goals)) { exclude("invalid_score"); continue; }
    const row = { source: String(match.source), fixture_id: String(match.fixture_id), kickoff: new Date(timestamp).toISOString(),
      home_team: String(match.home_team), away_team: String(match.away_team),
      home_goals: Number(match.home_goals), away_goals: Number(match.away_goals) };
    const source = row.source.toLowerCase();
    if ((source === "espn" || source === "app") && /^espn-[a-z0-9._]+-\d+$/.test(row.fixture_id)) {
      const group = espnGroups.get(row.fixture_id) ?? [];
      group.push(row);
      espnGroups.set(row.fixture_id, group);
    } else {
      const key = row.source + "|" + row.fixture_id;
      if (seen.has(key)) { exclude("duplicate_fixture"); continue; }
      seen.add(key);
      eligibleRows.push(row);
    }
  }
  for (const group of espnGroups.values()) {
    const preferred = group.find(row => row.source.toLowerCase() === "espn") ?? group[0];
    const agrees = row => row.kickoff === preferred.kickoff &&
      norm(row.home_team) === norm(preferred.home_team) && norm(row.away_team) === norm(preferred.away_team) &&
      row.home_goals === preferred.home_goals && row.away_goals === preferred.away_goals;
    if (!group.every(agrees)) {
      group.forEach(() => exclude("conflicting_fixture"));
      continue;
    }
    eligibleRows.push(preferred);
    group.filter(row => row !== preferred).forEach(() => exclude("duplicate_fixture"));
  }
  for (const row of eligibleRows) {
    const homeName = norm(row.home_team), awayName = norm(row.away_team);
    if (homeName === home && awayName !== away) homeRows.push({ ...row, gf: row.home_goals, ga: row.away_goals });
    else if (awayName === away && homeName !== home) awayRows.push({ ...row, gf: row.away_goals, ga: row.home_goals });
    else exclude("not_relevant_home_or_away_venue");
  }
  const newest = rows => rows.sort((a, b) => Date.parse(b.kickoff) - Date.parse(a.kickoff)).slice(0, max_matches);
  const homeSample = newest(homeRows), awaySample = newest(awayRows);
  counts.used = homeSample.length + awaySample.length;
  counts.excluded += homeRows.length - homeSample.length + awayRows.length - awaySample.length;
  if (homeRows.length + awayRows.length > counts.used) counts.reasons.outside_last_n = homeRows.length + awayRows.length - counts.used;
  if (homeSample.length < min_matches || awaySample.length < min_matches) {
    return unavailable("insufficient_verified_venue_sample", { home_samples: homeSample.length, away_samples: awaySample.length,
      required_per_team: min_matches, max_matches_per_team: max_matches });
  }
  const homeGF = rate(homeSample.map(row => row.gf)), homeGA = rate(homeSample.map(row => row.ga));
  const awayGF = rate(awaySample.map(row => row.gf)), awayGA = rate(awaySample.map(row => row.ga));
  // Attack strength = team's venue GF / league venue average.
  // Defensive weakness = opponent venue GA / league venue average.
  const lambdaHome = leagueHome * (homeGF / leagueHome) * (awayGA / leagueHome);
  const lambdaAway = leagueAway * (awayGF / leagueAway) * (homeGA / leagueAway);
  if (![lambdaHome, lambdaAway].every(value => Number.isFinite(value) && value >= 0 && value <= 12)) {
    return unavailable("invalid_expected_goals", { home_samples: homeSample.length, away_samples: awaySample.length });
  }

  const homeGoals = Array.from({ length: max_goals + 1 }, (_, goals) => poisson(lambdaHome, goals));
  const awayGoals = Array.from({ length: max_goals + 1 }, (_, goals) => poisson(lambdaAway, goals));
  let homeWin = 0, draw = 0, awayWin = 0, bttsYes = 0, over25 = 0, totalMass = 0;
  const scores = [];
  for (let h = 0; h <= max_goals; h++) for (let a = 0; a <= max_goals; a++) {
    const probability = homeGoals[h] * awayGoals[a];
    totalMass += probability;
    if (h > a) homeWin += probability; else if (h === a) draw += probability; else awayWin += probability;
    if (h > 0 && a > 0) bttsYes += probability;
    if (h + a >= 3) over25 += probability;
    scores.push({ home: h, away: a, probability });
  }
  if (totalMass < 0.999 || totalMass > 1.000001) return unavailable("probability_mass_truncated", { probability_mass: totalMass });
  const normalize = value => value / totalMass;
  const probabilities = { home_win: normalize(homeWin), draw: normalize(draw), away_win: normalize(awayWin),
    btts_yes: normalize(bttsYes), btts_no: normalize(totalMass - bttsYes),
    over_2_5: normalize(over25), under_2_5: normalize(totalMass - over25) };
  const outcomeTotal = probabilities.home_win + probabilities.draw + probabilities.away_win;
  const bttsTotal = probabilities.btts_yes + probabilities.btts_no;
  const goalsTotal = probabilities.over_2_5 + probabilities.under_2_5;
  if ([outcomeTotal, bttsTotal, goalsTotal].some(value => Math.abs(value - 1) > 1e-10)) return unavailable("probability_invariant_failed");
  scores.sort((a, b) => b.probability - a.probability);
  return { available: true, model: "venue_attack_defence_poisson", home_samples: homeSample.length, away_samples: awaySample.length,
    lambda_home: lambdaHome, lambda_away: lambdaAway, league_averages: { home: leagueHome, away: leagueAway },
    team_rates: { home_attack_goals: homeGF, home_conceded_goals: homeGA, away_attack_goals: awayGF, away_conceded_goals: awayGA },
    probabilities, most_likely_scores: scores.slice(0, 5), used_fixtures: [...homeSample, ...awaySample],
    data_quality: { identity_and_score_verified: true, completed_only: true, venue_split: true, league_averages_supplied: true,
      reliability: homeSample.length >= 8 && awaySample.length >= 8 ? "good" : "limited_sample" }, ...counts };
}
