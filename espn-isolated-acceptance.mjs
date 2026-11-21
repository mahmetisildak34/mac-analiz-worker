// Fail-closed ESPN scoreboard acceptance helpers. No network or database side effects.
export function verifyEspnEvent(event, league, expectedDay) {
  if (!event || typeof event !== "object" || !/^[a-z0-9._-]+$/i.test(league) || !/^\d{8}$/.test(expectedDay)) return null;
  const id = String(event.id ?? "");
  const date = event.date;
  if (!/^\d+$/.test(id) || !date || !Number.isFinite(Date.parse(date)) || date.slice(0, 10).replaceAll("-", "") !== expectedDay) return null;
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors;
  if (!Array.isArray(competitors) || competitors.length !== 2) return null;
  const home = competitors.find(x => x.homeAway === "home");
  const away = competitors.find(x => x.homeAway === "away");
  if (!home || !away || home === away || !home.team?.displayName || !away.team?.displayName) return null;
  const completed = event.status?.type?.completed === true || competition.status?.type?.completed === true;
  const validScore = x => typeof x === "string" && /^(0|[1-9]\d*)$/.test(x) || Number.isInteger(x) && x >= 0;
  const scoreVerified = completed && validScore(home.score) && validScore(away.score);
  return {
    source: "ESPN", fixture_id: `espn-${league}-${id}`, kickoff: new Date(date).toISOString(),
    home_team: home.team.displayName, away_team: away.team.displayName,
    home_goals: scoreVerified ? Number(home.score) : null,
    away_goals: scoreVerified ? Number(away.score) : null,
    identity_verified: 1, score_verified: scoreVerified ? 1 : 0,
    statistics_verified: 0, statistics_json: null,
    raw_json: JSON.stringify(event)
  };
}
export function verifyEspnScoreboard(payload, league, day, limit = 10) {
  if (!payload || !Array.isArray(payload.events) || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("invalid scoreboard or pilot limit");
  const seen = new Set(), accepted = [];
  for (const event of payload.events) {
    const match = verifyEspnEvent(event, league, day);
    if (!match || seen.has(match.fixture_id)) continue;
    seen.add(match.fixture_id);
    accepted.push(match);
    if (accepted.length === limit) break;
  }
  return accepted;
}
export function makeIsolatedInsert(match) {
  if (match?.source !== "ESPN" || match?.identity_verified !== 1 || !/^espn-[a-z0-9._-]+-\d+$/i.test(match.fixture_id)) throw new Error("unverified ESPN identity");
  const fields = ["source","fixture_id","kickoff","home_team","away_team","home_goals","away_goals","identity_verified","score_verified","statistics_verified","raw_json","statistics_json"];
  return {sql:`INSERT INTO mam_archive_test_matches (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")}) ON CONFLICT(source,fixture_id) DO NOTHING`,params:fields.map(x=>match[x] ?? null)};
}
