import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { closeSync, openSync, unlinkSync } from "node:fs";
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

function readSnapshot(database) {
  const staged = database.prepare("SELECT * FROM staged ORDER BY kickoff, fixture_id").all();
  const withheld = database.prepare("SELECT * FROM quarantine ORDER BY reason, evidence").all();
  const sha256 = createHash("sha256").update(JSON.stringify({ staged, withheld })).digest("hex");
  return { staged, withheld, sha256 };
}

export function verifyUefaSnapshot(sqlitePath) {
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const [result, ...rest] = database.prepare("PRAGMA integrity_check").all();
    if (rest.length || result?.integrity_check !== "ok") throw new Error("SQLite integrity check failed");
    const manifests = database.prepare("SELECT value FROM manifest").all();
    if (manifests.length !== 1) throw new Error("Expected exactly one snapshot manifest");
    const manifest = JSON.parse(manifests[0].value);
    const { staged, withheld, sha256 } = readSnapshot(database);
    if (manifest?.sha256 !== sha256 || manifest.staged !== staged.length ||
        manifest.quarantined !== withheld.length || !Number.isFinite(Date.parse(manifest.cutoff))) {
      throw new Error("Snapshot does not match its manifest");
    }
    return manifest;
  } finally {
    database.close();
  }
}

function verify(candidate, cutoff, aliases) {
  const { slug, espn, uefa } = candidate ?? {};
  const [leagueId, uefaPath] = competitions.get(slug) ?? [];
  const event = espn?.event;
  if (!leagueId || !numericId(event?.id) || !numericId(uefa?.id)) return null;

  const kickoff = event.date;
  const scheduled = uefa.status === "scheduled";
  const ms = Date.parse(kickoff);
  if (typeof kickoff !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?Z$/.test(kickoff) ||
      !Number.isFinite(ms) || (scheduled ? ms < cutoff : ms >= cutoff)) return null;
  if (scheduled && Date.parse(uefa.kickoff) !== ms) return null;
  const day = kickoff.slice(0, 10);
  if (new Date(ms).toISOString().slice(0, 16) !== kickoff.slice(0, 16) || day !== uefa.day) return null;

  const expectedEspn = "https://site.api.espn.com/apis/site/v2/sports/soccer/" + slug +
    "/scoreboard?dates=" + day.slice(0, 7).replace("-", "") + "&limit=500";
  // UEFA used Europa Conference League in canonical links before the 2024/25 rename.
  const officialPath = slug === "uefa.europa.conf" ? "uefa(?:europa)?conferenceleague" : uefaPath;
  const expectedUefa = new RegExp("^https://www\\.uefa\\.com/" + officialPath + "/match/" +
    uefa.id + "(?:--(?:[a-z0-9-]|%[0-9A-Fa-f]{2})+)?/$");
  if (espn.url !== expectedEspn || typeof uefa.url !== "string" || !expectedUefa.test(uefa.url)) return null;

  const match = event.competitions?.[0];
  const status = event.status?.type ?? match?.status?.type;
  if (!Array.isArray(event.competitions) || event.competitions.length !== 1 ||
      !Array.isArray(match?.competitors) || match.competitors.length !== 2) return null;
  if (scheduled) {
    if (status?.completed !== false || status.state !== "pre" || status.name !== "STATUS_SCHEDULED" ||
        uefa.homeGoals != null || uefa.awayGoals != null) return null;
  } else if (status?.completed !== true || status.state !== "post" ||
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
  const homeGoals = scheduled ? null : score(home.score);
  const awayGoals = scheduled ? null : score(away.score);
  if (!homeKey || !awayKey || homeKey === awayKey ||
      homeKey !== normalizeTeam(uefa.home, aliases) || awayKey !== normalizeTeam(uefa.away, aliases) ||
      (!scheduled && (homeGoals === null || awayGoals === null ||
        homeGoals !== score(uefa.homeGoals) || awayGoals !== score(uefa.awayGoals)))) return null;

  return {
    fixtureId: "espn-" + slug + "-" + event.id, leagueId, kickoff, homeName, awayName,
    homeGoals, awayGoals, status: scheduled ? "NS" : "FT",
    matchKey: [leagueId, day, homeKey, awayKey].join("|"),
    uefaKey: [leagueId, uefa.id].join("|"), espnUrl: espn.url, uefaUrl: uefa.url,
    evidence: JSON.stringify({ espn: event, uefa }),
  };
}

export function stageUefaBackfill({ candidates, archive, before, aliases = {} }, sqlitePath = ":memory:") {
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

  if (sqlitePath !== ":memory:") closeSync(openSync(sqlitePath, "wx", 0o600));
  let database;
  let committed = false;
  try {
    database = new DatabaseSync(sqlitePath);
    database.exec(`CREATE TABLE staged (
      fixture_id TEXT PRIMARY KEY, uefa_key TEXT UNIQUE, match_key TEXT UNIQUE,
      league_id TEXT, kickoff TEXT, home TEXT, away TEXT, home_goals INTEGER,
      away_goals INTEGER, espn_url TEXT, uefa_url TEXT, evidence TEXT,
      status TEXT NOT NULL CHECK (
        (status = 'NS' AND home_goals IS NULL AND away_goals IS NULL) OR
        (status = 'FT' AND home_goals IS NOT NULL AND away_goals IS NOT NULL)
      )
    );
    CREATE TABLE quarantine (reason TEXT NOT NULL, evidence TEXT NOT NULL);
    CREATE TABLE manifest (value TEXT NOT NULL)`);
    const insert = database.prepare("INSERT INTO staged VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const quarantine = database.prepare("INSERT INTO quarantine VALUES (?, ?)");
    const verified = [];
    const rejected = [];
    database.exec("BEGIN");
    for (const candidate of candidates) {
      const row = verify(candidate, cutoff, aliases);
      if (row) verified.push(row);
      else {
        rejected.push(candidate?.espn?.event?.id ?? null);
        quarantine.run("unverified_evidence", JSON.stringify(candidate ?? null));
      }
    }
    const counts = new Map();
    for (const row of verified) {
      for (const key of [row.fixtureId, row.uefaKey, row.matchKey]) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const existing = [];
    const duplicate = [];
    for (const row of verified) {
      if ([row.fixtureId, row.uefaKey, row.matchKey].some(key => counts.get(key) !== 1)) {
        duplicate.push(row.fixtureId);
        quarantine.run("duplicate_identity", row.evidence);
      } else if (archivedIds.has(row.fixtureId) || archivedUefaIds.has(row.uefaKey) || archivedKeys.has(row.matchKey)) {
        existing.push(row.fixtureId);
      } else {
        insert.run(row.fixtureId, row.uefaKey, row.matchKey, row.leagueId, row.kickoff,
          row.homeName, row.awayName, row.homeGoals, row.awayGoals, row.espnUrl, row.uefaUrl, row.evidence, row.status);
      }
    }
    const { staged, withheld, sha256 } = readSnapshot(database);
    const manifest = {
      cutoff: new Date(cutoff).toISOString(), staged: staged.length, quarantined: withheld.length,
      sha256,
    };
    database.prepare("INSERT INTO manifest VALUES (?)").run(JSON.stringify(manifest));
    database.exec("COMMIT");
    committed = true;
    return { verified, rejected, duplicate, existing, staged, manifest };
  } finally {
    database?.close();
    if (!committed && sqlitePath !== ":memory:") unlinkSync(sqlitePath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.argv[2];
  const target = process.argv[3];
  if (!input || (input === "--verify" && !target)) {
    throw new Error("Usage: node research/uefa-archive-backfill.mjs <evidence.json> [new-local.sqlite] | --verify <local.sqlite>");
  }
  const result = input === "--verify" ? verifyUefaSnapshot(target)
    : stageUefaBackfill(JSON.parse(await readFile(input, "utf8")), target);
  process.stdout.write(JSON.stringify(result) + "\n");
}
