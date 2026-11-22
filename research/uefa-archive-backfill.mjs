import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const competitions = new Map([
  ["uefa.champions", ["2", "uefachampionsleague"]],
  ["uefa.europa", ["3", "uefaeuropaleague"]],
  ["uefa.europa.conf", ["848", "uefaconferenceleague"]],
]);

const name = value => String(value ?? "").normalize("NFD").toLowerCase()
  .replace(/\p{M}/gu, "").replace(/ı/g, "i").replace(/ø/g, "o").replace(/ł/g, "l")
  .replace(/[^a-z0-9]/g, "");
const numericId = value => /^[1-9]\d*$/.test(String(value ?? ""));
const score = value => /^(0|[1-9]\d?)$/.test(String(value ?? "")) ? Number(value) : null;
const normalizeTeam = (value, aliases) => {
  const key = name(value);
  return Object.hasOwn(aliases, key) ? name(aliases[key]) : key;
};

function verify(candidate, cutoff, aliases) {
  const { slug, espn, uefa } = candidate ?? {};
  const [leagueId, uefaPath] = competitions.get(slug) ?? [];
  const event = espn?.event;
  if (!leagueId || !numericId(event?.id) || !numericId(uefa?.id)) return null;

  const kickoff = event.date;
  const ms = Date.parse(kickoff);
  if (typeof kickoff !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?Z$/.test(kickoff) ||
      !Number.isFinite(ms) || ms >= cutoff) return null;
  const day = kickoff.slice(0, 10);
  if (new Date(ms).toISOString().slice(0, 16) !== kickoff.slice(0, 16) || day !== uefa.day) return null;

  const expectedEspn = "https://site.api.espn.com/apis/site/v2/sports/soccer/" + slug +
    "/scoreboard?dates=" + day.slice(0, 7).replace("-", "") + "&limit=500";
  const expectedUefa = new RegExp("^https://www\\.uefa\\.com/" + uefaPath + "/match/" +
    uefa.id + "(?:--(?:[a-z0-9-]|%[0-9A-Fa-f]{2})+)?/$");
  if (espn.url !== expectedEspn || typeof uefa.url !== "string" || !expectedUefa.test(uefa.url)) return null;

  const match = event.competitions?.[0];
  const status = event.status?.type ?? match?.status?.type;
  if (!Array.isArray(event.competitions) || event.competitions.length !== 1 ||
      !Array.isArray(match?.competitors) || match.competitors.length !== 2 ||
      status?.completed !== true || status.state !== "post" ||
      !["STATUS_FULL_TIME", "STATUS_FINAL", "STATUS_FINAL_AET", "STATUS_FINAL_PEN"].includes(status.name)) return null;
  const home = match.competitors.find(side => side?.homeAway === "home");
  const away = match.competitors.find(side => side?.homeAway === "away");
  const homeId = home?.team?.id;
  const awayId = away?.team?.id;
  if (!numericId(homeId) || !numericId(awayId) || String(homeId) === String(awayId)) return null;

  const homeName = home.team.displayName;
  const awayName = away.team.displayName;
  const homeKey = normalizeTeam(homeName, aliases);
  const awayKey = normalizeTeam(awayName, aliases);
  const homeGoals = score(home.score);
  const awayGoals = score(away.score);
  if (!homeKey || !awayKey || homeKey === awayKey ||
      homeKey !== normalizeTeam(uefa.home, aliases) || awayKey !== normalizeTeam(uefa.away, aliases) ||
      homeGoals === null || awayGoals === null ||
      homeGoals !== score(uefa.homeGoals) || awayGoals !== score(uefa.awayGoals)) return null;

  return {
    fixtureId: "espn-" + slug + "-" + event.id, leagueId, kickoff, homeName, awayName,
    homeGoals, awayGoals, matchKey: [leagueId, day, homeKey, awayKey].join("|"),
    uefaKey: [leagueId, uefa.id].join("|"), espnUrl: espn.url, uefaUrl: uefa.url,
    evidence: JSON.stringify({ espn: event, uefa }),
  };
}

export function stageUefaBackfill({ candidates, archive, before, aliases = {} }) {
  const cutoff = Date.parse(before);
  if (!Number.isFinite(cutoff)) throw new TypeError("A valid cutoff is required");
  const archivedIds = new Set();
  const archivedKeys = new Set();
  const archivedUefaIds = new Set();
  for (const row of archive) {
    if (row.fixtureId) archivedIds.add(row.fixtureId);
    if (row.uefaKey) archivedUefaIds.add(row.uefaKey);
    const day = String(row.kickoff ?? "").slice(0, 10);
    const home = normalizeTeam(row.homeName, aliases);
    const away = normalizeTeam(row.awayName, aliases);
    if (day && home && away) archivedKeys.add([row.leagueId, day, home, away].join("|"));
  }

  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE staged (
      fixture_id TEXT PRIMARY KEY, uefa_key TEXT UNIQUE, match_key TEXT UNIQUE,
      league_id TEXT, kickoff TEXT, home TEXT, away TEXT, home_goals INTEGER,
      away_goals INTEGER, espn_url TEXT, uefa_url TEXT, evidence TEXT
    )`);
    const insert = database.prepare("INSERT INTO staged VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const verified = [];
    const rejected = [];
    for (const candidate of candidates) {
      const row = verify(candidate, cutoff, aliases);
      if (row) verified.push(row);
      else rejected.push(candidate?.espn?.event?.id ?? null);
    }
    const counts = new Map();
    for (const row of verified) {
      for (const key of [row.fixtureId, row.uefaKey, row.matchKey]) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const existing = [];
    const duplicate = [];
    database.exec("BEGIN");
    for (const row of verified) {
      if ([row.fixtureId, row.uefaKey, row.matchKey].some(key => counts.get(key) !== 1)) {
        duplicate.push(row.fixtureId);
      } else if (archivedIds.has(row.fixtureId) || archivedUefaIds.has(row.uefaKey) || archivedKeys.has(row.matchKey)) {
        existing.push(row.fixtureId);
      } else {
        insert.run(row.fixtureId, row.uefaKey, row.matchKey, row.leagueId, row.kickoff,
          row.homeName, row.awayName, row.homeGoals, row.awayGoals, row.espnUrl, row.uefaUrl, row.evidence);
      }
    }
    database.exec("COMMIT");
    return { verified, rejected, duplicate, existing, staged: database.prepare("SELECT * FROM staged ORDER BY kickoff, fixture_id").all() };
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.argv[2];
  if (!input) throw new Error("Usage: node research/uefa-archive-backfill.mjs <evidence.json>");
  const result = stageUefaBackfill(JSON.parse(await readFile(input, "utf8")));
  process.stdout.write(JSON.stringify(result) + "\n");
}
