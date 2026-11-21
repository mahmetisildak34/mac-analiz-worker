import { predictTrustedGoals, predictTrustedHalfTime } from "../trusted-goal-poisson.js";

function historyRow(row) {
  return {
    source: row?.source ?? row?.mamSource,
    fixture_id: row?.fixture?.id,
    kickoff: row?.fixture?.date,
    status: row?.fixture?.status?.short,
    league_id: row?.league?.id,
    home_team: row?.teams?.home?.name,
    away_team: row?.teams?.away?.name,
    home_team_id: row?.teams?.home?.id,
    away_team_id: row?.teams?.away?.id,
    home_goals: row?.goals?.home,
    away_goals: row?.goals?.away,
    identity_verified: row?.identity_verified === true,
    score_verified: row?.score_verified === true,
    conflicting: row?.conflicting === true,
    halftime_home_goals: row?.score?.halftime?.home,
    halftime_away_goals: row?.score?.halftime?.away,
    halftime_score_verified: row?.halftime_score_verified === true,
  };
}

export function analyzeArchiveResponse({ status, body } = {}, options) {
  if (status !== 200 || body?.ok === false || !Array.isArray(body?.response)) {
    return { available: false, reason: "archive_unavailable", http_status: status ?? null };
  }
  const history = body.response.map(historyRow);
  const fullTime = predictTrustedGoals(history, options);
  const firstHalf = predictTrustedHalfTime(history, options);
  return { available: fullTime.available || firstHalf.available, fullTime, firstHalf };
}

export async function analyzeArchiveFetchResponse(response, options) {
  const status = response?.status ?? null;
  if (status !== 200) return analyzeArchiveResponse({ status }, options);
  let body;
  try {
    body = await response.json();
  } catch {
    return { available: false, reason: "archive_invalid_json", http_status: status };
  }
  return analyzeArchiveResponse({ status, body }, options);
}
