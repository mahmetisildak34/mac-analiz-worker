const competitions = {
  "champions-league":"2", "europa-league":"3", "conference-league":"848"
};

export function parseFixtureDownloadUtc(value) {
  const parts = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})Z$/.exec(value ?? "");
  if (!parts) return null;
  const iso = parts[1] + "T" + parts[2] + ".000Z";
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) && date.toISOString() === iso ? iso : null;
}

const name = value => String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const goals = value => /^(?:0|[1-9]\d?)$/.test(String(value ?? "")) ? Number(value) : null;

export function fixtureDownloadFeed(fixtureId, leagueId) {
  const id = /^fd-uefa-(champions-league|europa-league|conference-league)-(20(?:24|25|26|27))-(\d+)$/.exec(fixtureId);
  if (!id || competitions[id[1]] !== String(leagueId)) return null;
  return { slug:id[1]+"-"+id[2], number:id[3] };
}

export function resolveFixtureDownloadImport(input, feed, rows) {
  if (!Array.isArray(rows) || input.status !== "FT") return null;
  const original = rows.filter(row => String(row?.MatchNumber) === feed.number);
  if (original.length !== 1) return null;
  const row = original[0], kickoff = parseFixtureDownloadUtc(row.DateUtc);
  if (!kickoff || !name(input.homeName) || !name(input.awayName) ||
      name(row.HomeTeam) !== name(input.homeName) || name(row.AwayTeam) !== name(input.awayName) ||
      goals(row.HomeTeamScore) === null || goals(row.AwayTeamScore) === null ||
      goals(row.HomeTeamScore) !== goals(input.homeGoals) || goals(row.AwayTeamScore) !== goals(input.awayGoals)) return null;
  const submitted = parseFixtureDownloadUtc(String(input.kickoff).replace(/\.000Z$/, "Z"));
  if (!submitted || (submitted !== kickoff && submitted !== kickoff.slice(0,10) + "T12:00:00.000Z")) return null;
  return {kickoff, evidence:{provider:"FixtureDownload", source_url:"https://fixturedownload.com/feed/json/"+feed.slug, original:row}};
}
