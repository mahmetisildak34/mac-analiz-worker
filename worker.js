// Deployment refresh: publish the reviewed Worker configuration and cache policy.
// Audit trigger: deploy this verified revision so the post-deploy archive audit runs.
const ALLOWED_ORIGIN = "https://mahmetisildak34.github.io";
const API_BASE = "https://v3.football.api-sports.io";
const FOOTBALLDATA_BASE = "https://api.football-data.org/v4";
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const CACHE_SECONDS = 43200;
const STANDINGS_CACHE_SECONDS = 300;

async function verifySessionToken(token, secret) {
  if (!token || !secret) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  let sig;
  try {
    sig = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const data = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (!data.exp || data.exp < Date.now() || data.v !== 1) return false;
  } catch (_) { return false; }
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(payload));
}

async function createSessionToken(secret) {
  const payload = btoa(JSON.stringify({ v: 1, exp: Date.now() + 90 * 24 * 60 * 60 * 1000 }))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return payload + "." + signature;
}


const TEAM_NAME_ALIASES = Object.freeze({
  "man-utd":"manchester-united", "man-united":"manchester-united",
  "man-city":"manchester-city", "hull":"hull-city", "hull-city-afc":"hull-city",
  "brighton":"brighton-hove-albion", "brighton-hove":"brighton-hove-albion",
  "west-ham":"west-ham-united", "west-ham-united":"west-ham-united",
  "wolves":"wolverhampton-wanderers", "nottm-forest":"nottingham-forest",
  "nott-m-forest":"nottingham-forest", "nott-s-forest":"nottingham-forest",
  "notts-forest":"nottingham-forest", "newcastle":"newcastle-united",
  "leeds":"leeds-united", "ipswich":"ipswich-town", "bournemouth":"afc-bournemouth",
  "inter":"inter-milan", "internazionale":"inter-milan", "ac-milan":"milan",
  "ath-madrid":"atletico-madrid", "atletico":"atletico-madrid",
  "psg":"paris-saint-germain", "bayern":"bayern-munich",
  "dortmund":"borussia-dortmund", "sporting":"sporting-cp",
  "sporting-lisbon":"sporting-cp", "ajax-amsterdam":"ajax", "psv-eindhoven":"psv",
  "karagumruk":"fatih-karagumruk", "rizespor":"caykur-rizespor",
  "buyuksehyr":"istanbul-basaksehir", "basaksehir":"istanbul-basaksehir",
  "istanbul-bb":"istanbul-basaksehir", "istanbul-basaksehir-fk":"istanbul-basaksehir", "basaksehir-fk":"istanbul-basaksehir",
  "erzurumspor":"erzurum-bb", "amedspor":"amed-sk",
  "vitoria-sc":"vitoria-guimaraes", "sl-benfica":"benfica",
  "cd-nacional":"nacional", "maritimo-m":"maritimo",
  "estoril-praia":"estoril", "casa-pia-ac":"casa-pia",
  "mjallby":"mjallby-aif", "iberia-tbilisi":"iberia-1999",
  "borac":"borac-banja-luka"
});

function normalizeTeamName(value) {
  const normalized = String(value || "").toLowerCase()
    .replace(/[ıİ]/g, "i").replace(/[şŞ]/g, "s").replace(/[ğĞ]/g, "g")
    .replace(/[çÇ]/g, "c").replace(/[öÖ]/g, "o").replace(/[üÜ]/g, "u")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/\b(football club|fc|afc|cf|sc|sk|fk)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  return TEAM_NAME_ALIASES[normalized] || normalized;
}

const ESPN_LEAGUE_COUNTRIES = Object.freeze({
  "1": "World", "2": "Europe", "3": "Europe", "4": "Europe", "5": "Europe",
  "6": "Africa", "15": "World", "39": "England", "40": "England",
  "45": "England", "48": "England", "61": "France", "62": "France", "66": "France",
  "71": "Brazil", "78": "Germany", "79": "Germany", "81": "Germany", "88": "Netherlands",
  "94": "Portugal", "98": "Japan", "128": "Argentina", "135": "Italy", "136": "Italy",
  "137": "Italy", "140": "Spain", "141": "Spain", "143": "Spain", "144": "Belgium",
  "169": "China", "179": "Scotland", "188": "Australia", "203": "Türkiye", "204": "Türkiye",
  "253": "USA", "262": "Mexico", "307": "Saudi Arabia"
});

function canonicalLeagueCountry(source, leagueId, leagueName, country) {
  const id = String(leagueId || "");
  const name = String(leagueName || "").toLowerCase();
  if (name.includes("afc u17 asian cup")) return "Asia";
  if (name.includes("uefa") || name.includes("european championship")) return "Europe";
  if (name.includes("saff championship")) return "Asia";
  if (name.includes("diski challenge")) return "South Africa";
  if (name.includes("kings cup")) return "Thailand";
  if (name.includes("australian championship") || name.includes("a-league")) return "Australia";
  if (String(source || "").toUpperCase() === "ESPN" && ESPN_LEAGUE_COUNTRIES[id]) {
    return ESPN_LEAGUE_COUNTRIES[id];
  }
  return String(country || "").trim();
}

async function normalizeKnownLeagueCountries(env) {
  if (!env.DB) return 0;
  const statements = Object.entries(ESPN_LEAGUE_COUNTRIES).map(([id, country]) =>
    env.DB.prepare("UPDATE matches SET country = ?, updated_at = CURRENT_TIMESTAMP WHERE source = 'ESPN' AND league_id = ? AND COALESCE(country, '') != ?")
      .bind(country, id, country)
  );
  const namedRules = [
    ["%AFC U17 Asian Cup%", "Asia"],
    ["%UEFA%", "Europe"],
    ["%European Championship%", "Europe"],
    ["%SAFF Championship%", "Asia"],
    ["%Diski Challenge%", "South Africa"],
    ["%King's Cup%", "Thailand"],
    ["%Australian Championship%", "Australia"],
    ["%A-League%", "Australia"]
  ];
  for (const [pattern, country] of namedRules) {
    statements.push(env.DB.prepare("UPDATE matches SET country = ?, updated_at = CURRENT_TIMESTAMP WHERE lower(league_name) LIKE lower(?) AND COALESCE(country, '') != ?")
      .bind(country, pattern, country));
  }
  const results = await env.DB.batch(statements);
  return results.reduce((sum, result) => sum + (Number(result?.meta?.changes) || 0), 0);
}

function hasUsableStatistics(value) {
  if (!value) return false;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== "object") return false;
    if (Array.isArray(parsed.teams)) return parsed.teams.some(team => Array.isArray(team?.statistics) && team.statistics.length > 0);
    if (Array.isArray(parsed.response)) return parsed.response.length > 0;
    if (Array.isArray(parsed)) return parsed.length > 0;
    return Object.values(parsed).some(value => Array.isArray(value) && value.length > 0);
  } catch (_) { return false; }
}

// Reuse a completed ESPN box score only when another provider's row has the
// same normalized home/away names and kickoff within 10 minutes. Never overwrite
// existing statistics or infer a match from league IDs alone.
async function enrichExactCrossSourceMatches(env) {
  if (!env.DB) return { checked: 0, updated: 0, reason: "DB binding missing" };
  if (!env.MAM_KV) return { checked: 0, updated: 0, reason: "Durable KV checkpoint unavailable; scan safely paused" };

  // v4 uses durable keyset cursors and a completed flag. It never restarts
  // a finished historical scan, and every invocation reads at most 240+120 rows.
  const cursorKey = "mam:cross-source-scan-cursors:v4";
  const cursors = (await env.MAM_KV.get(cursorKey, "json")) || {};
  const sourceState = cursors.source || { cursor: null, complete: false };
  const missingState = cursors.missing || { cursor: null, complete: false };
  const sourceCursor = sourceState.cursor || null;
  const missingCursor = missingState.cursor || null;

  // Use bounded keyset windows. JSON completeness is checked in JS only after
  // selecting at most 120 ESPN rows, avoiding an unbounded JSON predicate scan.
  const sourceSql = "SELECT source, fixture_id, kickoff, country, league_name, home_team, away_team, home_goals, away_goals, statistics_json FROM matches" +
    (sourceCursor ? " WHERE (kickoff > ? OR (kickoff = ? AND (fixture_id > ? OR (fixture_id = ? AND source > ?))))" : "") +
    " ORDER BY kickoff ASC, fixture_id ASC, source ASC LIMIT 240";
  const missingSql = "SELECT source, fixture_id, kickoff, country, league_name, home_team, away_team, home_goals, away_goals, statistics_json FROM matches WHERE source = 'ESPN'" +
    (missingCursor ? " AND (kickoff > ? OR (kickoff = ? AND fixture_id > ?))" : "") +
    " ORDER BY kickoff ASC, fixture_id ASC LIMIT 120";
  const [sourceResult, missingResult] = await Promise.all([
    sourceState.complete ? Promise.resolve({ results: [] }) :
      (sourceCursor
        ? env.DB.prepare(sourceSql).bind(sourceCursor.kickoff, sourceCursor.kickoff, sourceCursor.fixtureId, sourceCursor.fixtureId, sourceCursor.source || "").all()
        : env.DB.prepare(sourceSql).all()),
    missingState.complete ? Promise.resolve({ results: [] }) :
      (missingCursor
        ? env.DB.prepare(missingSql).bind(missingCursor.kickoff, missingCursor.kickoff, missingCursor.fixtureId).all()
        : env.DB.prepare(missingSql).all())
  ]);
  const sourceRows = Array.isArray(sourceResult?.results) ? sourceResult.results : [];
  const scannedMissingRows = Array.isArray(missingResult?.results) ? missingResult.results : [];
  const source = sourceRows.filter(row => row.source !== "ESPN" && row.statistics_json && row.statistics_json !== "null");
  const missing = scannedMissingRows.filter(row => {
    const value = row.statistics_json;
    if (!value || value === "null") return true;
    try {
      const parsed = JSON.parse(value);
      const teams = Array.isArray(parsed?.teams) ? parsed.teams : [];
      return teams.length < 2 || !teams[0]?.statistics?.length || !teams[1]?.statistics?.length;
    } catch (_) { return true; }
  });

  const normalizeMatchTeam = value => normalizeTeamName(value);
  const normalizeLeague = value => String(value || "").normalize("NFD").toLowerCase()
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  const matchKey = row => normalizeMatchTeam(row.home_team) + "|" + normalizeMatchTeam(row.away_team);
  const normalizeCrossSourceStatistics = (value, homeName, awayName) => {
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      if (!parsed || typeof parsed !== "object") return null;
      const teams = Array.isArray(parsed.teams) ? parsed.teams : null;
      if (teams && teams.length >= 2) {
        const normalizedHome = normalizeMatchTeam(homeName);
        const normalizedAway = normalizeMatchTeam(awayName);
        const named = teams.map(item => ({
          item,
          name: normalizeMatchTeam(item?.team?.name || item?.team?.displayName || item?.team || item?.name || ""),
          side: String(item?.homeAway || item?.side || "").toLowerCase(),
          statistics: Array.isArray(item?.statistics) ? item.statistics : []
        }));
        const home = named.find(entry => entry.statistics.length && (entry.side === "home" || entry.side === "h" || entry.name === normalizedHome));
        const away = named.find(entry => entry.statistics.length && (entry.side === "away" || entry.side === "a" || entry.name === normalizedAway));
        if (home && away && home.item !== away.item) {
          if ((!home.name || home.name === normalizedHome) && (!away.name || away.name === normalizedAway)) {
            return { teams: [{ ...home.item, homeAway: "home" }, { ...away.item, homeAway: "away" }], summaryAvailable: true, source: "cross-source" };
          }
        }
      }
      const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed.response) ? parsed.response : null;
      if (!rows) return null;
      const normalizedHome = normalizeMatchTeam(homeName);
      const normalizedAway = normalizeMatchTeam(awayName);
      const mapped = rows.map(item => ({
        name: normalizeMatchTeam(item?.team?.name || item?.team?.displayName || item?.name || ""),
        team: item?.team?.name || item?.team?.displayName || item?.name || null,
        statistics: Array.isArray(item?.statistics) ? item.statistics : []
      }));
      const home = mapped.find(item => item.name === normalizedHome && item.statistics.length);
      const away = mapped.find(item => item.name === normalizedAway && item.statistics.length);
      if (!home || !away) return null;
      return { teams: [{ homeAway: "home", team: home.team || homeName, statistics: home.statistics }, { homeAway: "away", team: away.team || awayName, statistics: away.statistics }], summaryAvailable: true, source: "cross-source" };
    } catch (_) { return null; }
  };

  const statsIndex = new Map();
  let usableSourceStats = 0;
  for (const row of source) {
    const normalizedStatistics = normalizeCrossSourceStatistics(row.statistics_json, row.home_team, row.away_team);
    if (!normalizedStatistics) continue;
    usableSourceStats++;
    const key = matchKey(row);
    const time = Date.parse(row.kickoff || "");
    if (!key || key === "|" || !Number.isFinite(time)) continue;
    const list = statsIndex.get(key) || [];
    list.push({ source: row.source, fixtureId: row.fixture_id, time,
      country: normalizeLeague(row.country), league: normalizeLeague(row.league_name),
      homeGoals: row.home_goals, awayGoals: row.away_goals, statistics: JSON.stringify(normalizedStatistics) });
    statsIndex.set(key, list);
  }

  const updates = [];
  let exactTeamMatches = 0, scoreMismatches = 0, ambiguousMatches = 0;
  for (const row of missing) {
    const key = matchKey(row);
    const time = Date.parse(row.kickoff || "");
    if (!Number.isFinite(time) || !key || key === "|") continue;
    const candidates = statsIndex.get(key) || [];
    if (!candidates.length) continue;
    exactTeamMatches++;
    const sameScore = candidates.filter(candidate =>
      row.home_goals != null && row.away_goals != null &&
      candidate.homeGoals != null && candidate.awayGoals != null &&
      Number(row.home_goals) === Number(candidate.homeGoals) &&
      Number(row.away_goals) === Number(candidate.awayGoals));
    if (!sameScore.length) { scoreMismatches++; continue; }
    const safeCandidates = sameScore.map(candidate => ({
      ...candidate, delta: Math.abs(candidate.time - time),
      sameCountry: !normalizeLeague(row.country) || !candidate.country || normalizeLeague(row.country) === candidate.country,
      sameLeague: !normalizeLeague(row.league_name) || !candidate.league || normalizeLeague(row.league_name) === candidate.league
    })).filter(candidate => candidate.delta <= 6 * 60 * 60 * 1000 && candidate.sameCountry && candidate.sameLeague)
      .sort((a, b) => a.delta - b.delta);
    if (!safeCandidates.length) continue;
    if (safeCandidates.length > 1 && safeCandidates[1].delta - safeCandidates[0].delta < 30 * 60 * 1000) {
      ambiguousMatches++; continue;
    }
    updates.push(env.DB.prepare(
      "UPDATE matches SET statistics_json = ?, updated_at = CURRENT_TIMESTAMP WHERE source = 'ESPN' AND fixture_id = ? AND (statistics_json IS NULL OR statistics_json = '' OR statistics_json = 'null' OR json_valid(statistics_json) = 0 OR (CASE WHEN json_valid(statistics_json) = 1 THEN COALESCE(json_array_length(json_extract(statistics_json, '$.teams[0].statistics')), 0) ELSE 0 END = 0 OR CASE WHEN json_valid(statistics_json) = 1 THEN COALESCE(json_array_length(json_extract(statistics_json, '$.teams[1].statistics')), 0) ELSE 0 END = 0))"
    ).bind(safeCandidates[0].statistics, row.fixture_id));
  }
  let updated = 0;
  for (let i = 0; i < updates.length; i += 25) {
    const results = await env.DB.batch(updates.slice(i, i + 25));
    updated += results.reduce((sum, item) => sum + (Number(item?.meta?.changes) || 0), 0);
  }

  const lastSourceRow = scannedMissingRows.length ? null : sourceRows[sourceRows.length - 1];
  const sourceDone = sourceState.complete || sourceRows.length < 240;
  const missingDone = missingState.complete || scannedMissingRows.length < 120;
  const nextCursors = {
    source: { cursor: sourceRows.length ? {
      kickoff: sourceRows[sourceRows.length - 1].kickoff,
      fixtureId: sourceRows[sourceRows.length - 1].fixture_id,
      source: sourceRows[sourceRows.length - 1].source
    } : sourceCursor, complete: sourceDone },
    missing: { cursor: scannedMissingRows.length ? {
      kickoff: scannedMissingRows[scannedMissingRows.length - 1].kickoff,
      fixtureId: scannedMissingRows[scannedMissingRows.length - 1].fixture_id
    } : missingCursor, complete: missingDone }
  };
  await env.MAM_KV.put(cursorKey, JSON.stringify(nextCursors));
  const report = {
    ranAt: new Date().toISOString(), target: "ESPN rows missing either team's statistics",
    sourceRowsScanned: sourceRows.length, sourceBatchLimit: 240, sourceBatchFull: sourceRows.length === 240,
    missingEspnRowsScanned: scannedMissingRows.length, missingRowsNeedingRepair: missing.length,
    missingBatchLimit: 120, missingBatchFull: scannedMissingRows.length === 120,
    usableSourceStats, exactTeamMatches, scoreMismatches, ambiguousMatches,
    updateAttempts: updates.length, updated, cursorState: nextCursors,
    scanStatus: sourceDone && missingDone ? "scan-complete" : "more-batches-available"
  };
  await env.MAM_KV.put("mam:cross-source-stats:last:v4", JSON.stringify(report), { expirationTtl: 60 * 60 * 24 * 30 });
  console.log("ESPN missing-statistics cross-source repair report", report);
  return report;
}
// Safe, additive D1 indexes: they speed up league/date archive reads and status checks.
// CREATE INDEX IF NOT EXISTS leaves every existing match row untouched.
async function ensureArchiveIndexes(env) {
  if (!env.DB) return;
  // Schema changes belong in scheduled maintenance, never on the public request path.
  // The quota guard is created/upgraded once per maintenance window, not on every API call.
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS mam_api_quota_guard (day TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0, live_last_ms INTEGER NOT NULL DEFAULT 0, minute_last_ms INTEGER NOT NULL DEFAULT 0)"
  ).run();

  // Inspect the live schema instead of swallowing every ALTER TABLE error.
  // The scheduled migration must fail visibly if D1 cannot apply the change.
  const quotaSchema = await env.DB.prepare("PRAGMA table_info(mam_api_quota_guard)").all();
  const quotaColumns = new Set((quotaSchema?.results || []).map(column => String(column.name || "")));
  for (const [name, definition] of [
    ["live_last_ms", "INTEGER NOT NULL DEFAULT 0"],
    ["minute_last_ms", "INTEGER NOT NULL DEFAULT 0"]
  ]) {
    if (!quotaColumns.has(name)) {
      await env.DB.prepare("ALTER TABLE mam_api_quota_guard ADD COLUMN " + name + " " + definition).run();
    }
  }
  const verifiedQuotaSchema = await env.DB.prepare("PRAGMA table_info(mam_api_quota_guard)").all();
  const verifiedQuotaColumns = new Set((verifiedQuotaSchema?.results || []).map(column => String(column.name || "")));
  if (!verifiedQuotaColumns.has("live_last_ms") || !verifiedQuotaColumns.has("minute_last_ms")) {
    throw new Error("D1 quota guard migration verification failed: required columns are missing");
  }
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_matches_league_kickoff ON matches (league_id, kickoff)"
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_matches_status_kickoff ON matches (status, kickoff)"
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_matches_updated_at ON matches (updated_at)"
  ).run();
  // Composite indexes keep scheduled source and cross-provider scans off full-table paths.
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_matches_source_kickoff ON matches (source, kickoff DESC)"
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_matches_kickoff ON matches (kickoff DESC)"
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_matches_source_status_kickoff ON matches (source, status, kickoff)"
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_matches_kickoff_fixture_source ON matches (kickoff, fixture_id, source)"
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_matches_source_kickoff_fixture ON matches (source, kickoff, fixture_id)"
  ).run();
}

// KV archive writes are intentionally disabled on the free tier.
// Historical matches are served read-only from existing KV data and the app's CSV/ESPN fallbacks.


async function syncEspnFixturesToD1(env, lookBackDays = 45, lookAheadDays = 14, maxRequests = 40) {
  if (!env.DB || !env.MAM_KV) return { saved: 0, failed: 0, complete: false, reason: "DB or MAM_KV binding missing" };

  // Adaptive archive speed: only the hourly backfill is adjusted. Start moderate,
  // ramp up after healthy runs, and back off immediately on failures/write blocks.
  const adaptiveSpeedKey = "mam:espn-adaptive-speed:v1";
  let adaptiveSpeed = await env.MAM_KV.get(adaptiveSpeedKey, "json");
  if (!adaptiveSpeed || typeof adaptiveSpeed !== "object") adaptiveSpeed = { requests: 20, healthyRuns: 0 };
  let effectiveMaxRequests = maxRequests;
  if (maxRequests > 10) {
    const priorFailure = adaptiveSpeed.lastFailed > 0 || adaptiveSpeed.lastArchiveWriteBlocked === true ||
      adaptiveSpeed.lastSummaryFailures > 0 || adaptiveSpeed.lastPendingD1WriteFailure === true;
    const current = Math.max(16, Math.min(24, Number(adaptiveSpeed.requests) || 20));
    effectiveMaxRequests = priorFailure ? Math.max(16, current - 4) :
      (Number(adaptiveSpeed.healthyRuns || 0) >= 1 ? Math.min(24, current + 2) : current);
    adaptiveSpeed = { ...adaptiveSpeed, requests: effectiveMaxRequests };
  }
  // ESPN scoreboard coverage mirrors the app's supported ESPN fallback competitions.
  // Keep league IDs aligned with the app so every archived row is queryable by league.
  const leagues = [
    // First priority: the ten main competitions from the app's agreed rollout plan.
    ["39","eng.1","Premier League","England"],
    ["203","tur.1","Süper Lig","Türkiye"],
    ["140","esp.1","La Liga","Spain"],
    ["78","ger.1","Bundesliga","Germany"],
    ["135","ita.1","Serie A","Italy"],
    ["61","fra.1","Ligue 1","France"],
    ["2","uefa.champions","UEFA Champions League","Europe"],
    ["3","uefa.europa","UEFA Europa League","Europe"],
    ["88","ned.1","Eredivisie","Netherlands"],
    ["94","por.1","Primeira Liga","Portugal"],
    // Conference League is kept immediately after the ten primary leagues.
    ["848","uefa.europa.conf","UEFA Conference League","Europe"],
    ["40","eng.2","Championship","England"],
    ["45","eng.fa","FA Cup","England"],
    ["48","eng.league_cup","EFL Cup","England"],
    ["141","esp.2","La Liga 2","Spain"],
    ["143","esp.copa_del_rey","Copa del Rey","Spain"],
    ["79","ger.2","2. Bundesliga","Germany"],
    ["81","ger.dfb_pokal","DFB Pokal","Germany"],
    ["136","ita.2","Serie B","Italy"],
    ["137","ita.coppa_italia","Coppa Italia","Italy"],
    ["62","fra.2","Ligue 2","France"],
    ["66","fra.coupe_de_france","Coupe de France","France"],
    ["144","bel.1","Belgian Pro League","Belgium"],
    ["204","tur.2","1. Lig","Türkiye"],
    ["179","sco.1","Scottish Premiership","Scotland"],
    ["253","usa.1","MLS","USA"],
    ["71","bra.1","Brasileirão","Brazil"],
    ["128","arg.1","Liga Profesional","Argentina"],
    ["262","mex.1","Liga MX","Mexico"],
    ["98","jpn.1","J1 League","Japan"],
    ["188","aus.1","A-League","Australia"],
    ["169","chn.1","Chinese Super League","China"],
    ["1","fifa.world","FIFA World Cup","World"],
    ["4","uefa.euro","UEFA European Championship","Europe"],
    ["5","uefa.nations","UEFA Nations League","Europe"],
    ["6","caf.nations","Africa Cup of Nations","Africa"],
    ["15","fifa.cwc","FIFA Club World Cup","World"],
    ["307","ksa.1","Saudi Pro League","Saudi Arabia"]
  ];

  const stateKey = "mam:espn-sync-state:v2";
  let state = await env.MAM_KV.get(stateKey, "json");
  if (!state || !Array.isArray(state.jobs) || !Number.isInteger(state.cursor) || state.cursor < 0 || state.cursor > state.jobs.length) {
    const dates = [];
    const base = new Date();
    base.setUTCHours(12, 0, 0, 0);
    for (let offset = -Math.max(1, lookBackDays); offset <= lookAheadDays; offset++) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + offset);
      dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
    }
    const jobs = [];
    // The active archive target is the ten agreed priority competitions.
    // Secondary competitions remain queryable from already archived D1 rows,
    // but do not consume the primary historical backfill budget.
    for (const league of leagues.slice(0, 10)) {
      for (const date of dates) jobs.push({ league, date, attempts: 0 });
    }
    state = { version: 2, jobs, cursor: 0, createdAt: new Date().toISOString() };
  } else {
    // Extend an in-flight legacy queue without discarding its cursor or any
    // already archived data. Promote pending priority jobs ahead of secondary
    // competitions, then append only missing priority league/date pairs.
    const completedPrefix = state.jobs.slice(0, state.cursor);
    const pendingJobs = state.jobs.slice(state.cursor);
    const priorityIds = new Set(leagues.slice(0, 10).map(league => String(league[0])));
    const priorityPending = [];
    const secondaryPending = [];
    const seenPriority = new Set(
      completedPrefix
        .filter(job => priorityIds.has(String(job?.league?.[0] || "")))
        .map(job => String(job.league[0]) + "|" + String(job.date || ""))
    );
    for (const job of pendingJobs) {
      const leagueId = String(job?.league?.[0] || "");
      if (priorityIds.has(leagueId)) {
        const key = leagueId + "|" + String(job.date || "");
        if (!seenPriority.has(key)) {
          seenPriority.add(key);
          priorityPending.push(job);
        }
      } else {
        secondaryPending.push(job);
      }
    }
    const base = new Date();
    base.setUTCHours(12, 0, 0, 0);
    for (let offset = -Math.max(1, lookBackDays); offset <= lookAheadDays; offset++) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + offset);
      const date = d.toISOString().slice(0, 10).replace(/-/g, "");
      for (const league of leagues.slice(0, 10)) {
        const key = String(league[0]) + "|" + date;
        if (!seenPriority.has(key)) {
          seenPriority.add(key);
          priorityPending.push({ league, date, attempts: 0 });
        }
      }
    }
    state.jobs = [...completedPrefix, ...priorityPending, ...secondaryPending];
    state.cursor = completedPrefix.length;
    state.version = 2;
  }

  // Historical fixture coverage is the active priority. While its queue is
  // pending, reserve the hourly ESPN request budget for scoreboard backfill.
  // Summary/statistics enrichment resumes automatically after this queue drains.
  const archiveBackfillActive = state.cursor < state.jobs.length;

  let batch = [];
  const rows = [];
  const retryJobs = [];
  const summaryQueueKey = "mam:espn-summary-queue:v1";
  let summaryQueue = await env.MAM_KV.get(summaryQueueKey, "json");
  if (!Array.isArray(summaryQueue)) summaryQueue = [];
  const summaryDoneKey = "mam:espn-summary-done:v1";
  let summaryDone = await env.MAM_KV.get(summaryDoneKey, "json");
  if (!Array.isArray(summaryDone)) summaryDone = [];
  const summaryDoneSet = new Set(summaryDone);

  // Keep the retry queue topped up without letting cooldown items block discovery.
  // Refill toward 480 (hard cap 500) on every scheduled run, not only when below 80.
  const summaryQueueBeforeDiscovery = summaryQueue.length;
  let recoveredSummaryItems = 0;
  const discoveryThrottleKey = "mam:espn-summary-discovery-last:v1";
  const lastDiscoveryAt = Number(await env.MAM_KV.get(discoveryThrottleKey) || 0);
  const discoveryDue = !lastDiscoveryAt || Date.now() - lastDiscoveryAt >= 24 * 60 * 60 * 1000;
  if (!archiveBackfillActive && summaryQueue.length < 480 && discoveryDue) {
    // D1 has a bounded bind-parameter budget. Do not generate one SQL placeholder
    // per queued fixture (a 458-item queue can make the query fail before summaries run).
    // Read a bounded candidate window and exclude queued IDs in JavaScript instead.
    const queuedFixtureIds = new Set(summaryQueue.map(item => String(item.fixtureId || "")).filter(Boolean));
    const discoveryCursorKey = "mam:espn-summary-discovery-cursor:v1";
    const discoveryCursor = await env.MAM_KV.get(discoveryCursorKey, "json");
    const discoverySql = "SELECT fixture_id AS fixtureId, kickoff FROM matches WHERE source = 'ESPN' AND status IN ('FT','AET','PEN','LIVE','1H','2H','HT','ET','P','INT') AND (" +
      "statistics_json IS NULL OR statistics_json = '' OR statistics_json = 'null' OR json_valid(statistics_json) = 0 OR (" +
      "CASE WHEN json_valid(statistics_json) = 1 THEN COALESCE(json_array_length(json_extract(statistics_json, '$.teams[0].statistics')), 0) ELSE 0 END = 0 OR " +
      "CASE WHEN json_valid(statistics_json) = 1 THEN COALESCE(json_array_length(json_extract(statistics_json, '$.teams[1].statistics')), 0) ELSE 0 END = 0))" +
      (discoveryCursor ? " AND (kickoff > ? OR (kickoff = ? AND fixture_id > ?))" : "") +
      " ORDER BY kickoff ASC, fixture_id ASC LIMIT 100";
    const missingRows = discoveryCursor
      ? await env.DB.prepare(discoverySql).bind(discoveryCursor.kickoff, discoveryCursor.kickoff, discoveryCursor.fixtureId).all()
      : await env.DB.prepare(discoverySql).all();
    const discoveredRows = Array.isArray(missingRows?.results) ? missingRows.results : [];
    let lastDiscoveryProcessed = null;
    await env.MAM_KV.put(discoveryThrottleKey, String(Date.now()), { expirationTtl: 60 * 60 * 24 });
    for (const row of discoveredRows) {
      if (summaryQueue.length >= 480) break;
      lastDiscoveryProcessed = row;
      const fixtureId = String(row.fixtureId || "");
      if (!fixtureId.startsWith("espn-")) continue;
      const splitAt = fixtureId.lastIndexOf("-");
      if (splitAt <= 5 || splitAt >= fixtureId.length - 1) continue;
      const slug = fixtureId.slice(5, splitAt);
      const eventId = fixtureId.slice(splitAt + 1);
      const key = "ESPN:" + fixtureId;
      // A missing-stat row must never be suppressed by a stale done marker.
      summaryDoneSet.delete(key);
      if (!queuedFixtureIds.has(fixtureId) && !summaryQueue.some(item => item.key === key)) {
        summaryQueue.push({ key, slug, fixtureId, eventId, attempts: 0, retryAfter: 0 });
        queuedFixtureIds.add(fixtureId);
        recoveredSummaryItems++;
      }
    }
    // Advance only through rows actually examined; never skip overflow when the queue fills.
    await env.MAM_KV.put(discoveryCursorKey, JSON.stringify(
      discoveredRows.length === 100 && lastDiscoveryProcessed
        ? { kickoff: lastDiscoveryProcessed.kickoff, fixtureId: lastDiscoveryProcessed.fixtureId }
        : null
    ), { expirationTtl: 60 * 60 * 24 * 30 });
  }

  // Stay within the Workers subrequest ceiling while preventing statistics
  // starvation during historical backfill. Reserve a small summary slice and
  // reduce scoreboard work by the same amount during archive backfill.
  const largeStatisticsBacklog = summaryQueue.length >= 100;
  const summaryBudget = archiveBackfillActive ? (maxRequests <= 10 ? 4 : 8) : (maxRequests <= 10 ? 4 : (largeStatisticsBacklog ? 24 : 16));
  const scoreboardBudget = effectiveMaxRequests <= 10 ? 10 : (archiveBackfillActive ? 40 : (largeStatisticsBacklog ? 24 : 32));
  const summaryBatchLimit = Math.min(summaryBudget, summaryQueue.length);
  const scoreboardBatchLimit = Math.min(effectiveMaxRequests, scoreboardBudget);
  batch = state.jobs.slice(state.cursor, state.cursor + Math.max(1, scoreboardBatchLimit));
  const queueAfterDiscovery = summaryQueue.length;

  let failed = 0;

  const fetchJob = async job => {
    const [leagueId, slug, leagueName, country] = job.league;
    try {
      const response = await fetch(ESPN_BASE + "/" + slug + "/scoreboard?dates=" + job.date + "&limit=500", {
        headers: { "Accept": "application/json" }
      });
      if (!response.ok) throw new Error("ESPN HTTP " + response.status);
      const payload = await response.json();
      for (const event of (Array.isArray(payload.events) ? payload.events : [])) {
        const competition = (event.competitions || [])[0] || {};
        const competitors = competition.competitors || [];
        const home = competitors.find(x => x.homeAway === "home") || {};
        const away = competitors.find(x => x.homeAway === "away") || {};
        const homeName = String(home.team?.displayName || home.team?.name || "").trim();
        const awayName = String(away.team?.displayName || away.team?.name || "").trim();
        if (!homeName || !awayName || !event.id || !event.date) continue;
        const type = event.status?.type || competition.status?.type || {};
        const stateName = String(type.state || "").toLowerCase();
        const status = type.completed === true || stateName === "post" ? "FT" : (stateName === "in" || stateName === "live") ? "LIVE" : "NS";
        const fixtureId = "espn-" + slug + "-" + String(event.id);
        const score = value => value == null || value === "" ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
        rows.push({
          source: "ESPN", fixtureId,
          leagueId, leagueName, country, kickoff: String(event.date), status,
          homeId: home.team?.id == null ? null : String(home.team.id), homeName,
          awayId: away.team?.id == null ? null : String(away.team.id), awayName,
          homeGoals: score(home.score), awayGoals: score(away.score), raw: JSON.stringify(event)
        });
        if ((status === "LIVE" || status === "FT") && summaryQueue.length < 500) {
          const key = "ESPN:" + fixtureId;
          if (!summaryDoneSet.has(key) && !summaryQueue.some(item => item.key === key)) {
            summaryQueue.push({ key, slug, fixtureId, eventId: String(event.id), attempts: 0 });
          }
        }
      }
    } catch (error) {
      failed++;
      const attempts = Number(job.attempts || 0);
      // Never discard a historical fixture job after a fixed retry count.
      // Keep failed dates in the tail of the queue so transient ESPN errors,
      // rate limits, and temporary outages are retried by later scheduled runs.
      retryJobs.push({ ...job, attempts: attempts + 1 });
      console.log("ESPN archive sync failed", slug, job.date, String(error?.message || error), "attempt", attempts + 1);
    }
  };

  // Small concurrent groups keep the invocation comfortably below the Workers subrequest ceiling.
  for (let i = 0; i < batch.length; i += 4) {
    await Promise.all(batch.slice(i, i + 4).map(fetchJob));
  }

  const sql = "INSERT INTO matches (source, fixture_id, league_id, league_name, country, kickoff, status, home_team_id, home_team, away_team_id, away_team, home_goals, away_goals, statistics_json, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, fixture_id) DO UPDATE SET league_id=excluded.league_id, league_name=excluded.league_name, country=excluded.country, kickoff=excluded.kickoff, status=excluded.status, home_team_id=excluded.home_team_id, home_team=excluded.home_team, away_team_id=excluded.away_team_id, away_team=excluded.away_team, home_goals=excluded.home_goals, away_goals=excluded.away_goals, raw_json=excluded.raw_json, updated_at=CURRENT_TIMESTAMP WHERE matches.league_id IS NOT excluded.league_id OR matches.league_name IS NOT excluded.league_name OR matches.country IS NOT excluded.country OR matches.kickoff IS NOT excluded.kickoff OR matches.status IS NOT excluded.status OR matches.home_team_id IS NOT excluded.home_team_id OR matches.home_team IS NOT excluded.home_team OR matches.away_team_id IS NOT excluded.away_team_id OR matches.away_team IS NOT excluded.away_team OR matches.home_goals IS NOT excluded.home_goals OR matches.away_goals IS NOT excluded.away_goals";
  let saved = 0;
  let archiveWriteBlocked = false;
  for (let i = 0; i < rows.length; i += 50) {
    const statements = rows.slice(i, i + 50).map(m => env.DB.prepare(sql).bind(
      m.source, m.fixtureId, m.leagueId, m.leagueName, m.country, m.kickoff, m.status,
      m.homeId, m.homeName, m.awayId, m.awayName, m.homeGoals, m.awayGoals, null, m.raw
    ));
    try {
      const result = await env.DB.batch(statements);
      saved += result.reduce((sum, item) => sum + (Number(item?.meta?.changes) || 0), 0);
    } catch (archiveWriteError) {
      archiveWriteBlocked = true;
      retryJobs.push(...batch.map(job => ({ ...job, attempts: Number(job.attempts || 0) + 1 })));
      console.log("ESPN archive D1 write blocked; preserving scoreboard jobs for retry", String(archiveWriteError?.message || archiveWriteError));
      break;
    }
  }

  // Fresh D1 fixture rows must invalidate the current half-goals snapshot immediately.
  if (saved > 0) {
    try { await env.MAM_KV.delete("mam:half-goals:v1:" + new Date().toISOString().slice(0, 13)); }
    catch (cacheError) { console.log("Half-goals cache invalidation failed after ESPN sync", String(cacheError?.message || cacheError)); }
  }

  // Fetch detailed box-score statistics for live and completed matches in small batches.
  // Scoreboard sync remains the source of truth for status and goals; summaries enrich statistics_json.
  // Keep the limited ESPN summary budget focused on the ten priority competitions.
  // Existing queued jobs are retained; only their processing order changes.
  const prioritySummarySlugs = new Set([
    "eng.1", "tur.1", "esp.1", "ger.1", "ita.1",
    "fra.1", "uefa.champions", "uefa.europa", "ned.1", "por.1"
  ]);
  const summaryLeaguePriority = item => prioritySummarySlugs.has(String(item?.slug || "")) ? 0 : 1;
  summaryQueue.sort((a, b) => summaryLeaguePriority(a) - summaryLeaguePriority(b));
  const nowMs = Date.now();
  const readySummaries = [];
  const deferredSummaries = [];
  for (const item of summaryQueue) {
    // One controlled early recheck for fixtures whose previous successful ESPN
    // summary contained no box score. This prevents a full-day cooldown from
    // leaving known gaps untouched, while the existing per-run budget keeps
    // provider traffic bounded. Failed HTTP requests still honor Retry-After.
    const eligibleForOneEarlyRecheck =
      Number(item.noStatsAttempts || 0) > 0 && item.cooldownAccelerated !== true;
    if ((Number(item.retryAfter || 0) <= nowMs || eligibleForOneEarlyRecheck) &&
        readySummaries.length < summaryBatchLimit) {
      readySummaries.push({
        ...item,
        ...(eligibleForOneEarlyRecheck ? { cooldownAccelerated: true } : {})
      });
    } else deferredSummaries.push(item);
  }
  summaryQueue = deferredSummaries;
  const summaryBatch = readySummaries;
  const summaryRetries = [];
  const summaryRun = {
    ranAt: new Date().toISOString(),
    queueBeforeDiscovery: summaryQueueBeforeDiscovery,
    recoveredFromD1: recoveredSummaryItems,
    queueAfterDiscovery,
    attempted: summaryBatch.length,
    fetchedWithStatistics: 0,
    noStatisticsReturned: 0,
    requestFailures: 0,
    requestFailureSamples: [],
    noStatisticsSamples: [],
    saved: 0
  };
  const pendingStatsKey = "mam:espn-summary-pending-d1:v1";
  let pendingStats = await env.MAM_KV.get(pendingStatsKey, "json");
  if (!Array.isArray(pendingStats)) pendingStats = [];
  // Retry previously fetched box scores from KV before spending another ESPN request.
  for (const pending of pendingStats.slice(0, 8)) {
    try {
      const pendingWriteResult = await env.DB.prepare(
        "UPDATE matches SET statistics_json = ?, updated_at = CURRENT_TIMESTAMP WHERE source = 'ESPN' AND fixture_id = ? AND (statistics_json IS NULL OR statistics_json = '' OR statistics_json = 'null' OR json_valid(statistics_json) = 0 OR (CASE WHEN json_valid(statistics_json) = 1 THEN COALESCE(json_array_length(json_extract(statistics_json, '$.teams[0].statistics')), 0) ELSE 0 END = 0 OR CASE WHEN json_valid(statistics_json) = 1 THEN COALESCE(json_array_length(json_extract(statistics_json, '$.teams[1].statistics')), 0) ELSE 0 END = 0))"
      ).bind(pending.statisticsJson, pending.fixtureId).run();
      const pendingChanges = Number(pendingWriteResult?.meta?.changes || 0);
      if (pendingChanges > 0) summaryRun.saved += pendingChanges;
      pendingStats = pendingStats.filter(entry => entry.fixtureId !== pending.fixtureId);
    } catch (pendingWriteError) {
      console.log("Pending ESPN summary D1 write retained for retry", pending.fixtureId, String(pendingWriteError?.message || pendingWriteError));
      break;
    }
  }
  await env.MAM_KV.put(pendingStatsKey, JSON.stringify(pendingStats));
  for (let i = 0; i < summaryBatch.length; i += 4) {
    await Promise.all(summaryBatch.slice(i, i + 4).map(async item => {
      let retryAfterHeader = null;
      let fetchedStatsJson = null;
      try {
        const response = await fetch(ESPN_BASE + "/" + item.slug + "/summary?event=" + encodeURIComponent(item.eventId), {
          headers: { "Accept": "application/json" }
        });
        if (!response.ok) {
          retryAfterHeader = response.headers.get("Retry-After");
          throw new Error("ESPN summary HTTP " + response.status);
        }
        const payload = await response.json();
        const teams = Array.isArray(payload?.boxscore?.teams) ? payload.boxscore.teams : [];
        let statistics = teams.map(team => ({
          homeAway: team.homeAway || null,
          team: team.team?.displayName || team.team?.name || null,
          statistics: Array.isArray(team.statistics) ? team.statistics : []
        }));
        let hasActualStatistics = statistics.length >= 2 &&
          statistics.filter(team => team.statistics.length > 0).length >= 2;

        // Fallback: ESPN soccer summaries sometimes omit boxscore team stats,
        // while Core API exposes each competitor's statistics separately.
        if (!hasActualStatistics) {
          const competitors = payload?.header?.competitions?.[0]?.competitors
            || payload?.competitions?.[0]?.competitors
            || [];
          const teamIds = competitors.map(c => String(c?.id || c?.team?.id || ""))
            .filter(Boolean).slice(0, 2);
          if (teamIds.length === 2) {
            const coreBase = "https://sports.core.api.espn.com/v2/sports/soccer/leagues/" +
              encodeURIComponent(item.slug) + "/events/" + encodeURIComponent(item.eventId) +
              "/competitions/" + encodeURIComponent(item.eventId) + "/competitors/";
            const coreResults = await Promise.all(teamIds.map(async teamId => {
              try {
                const coreResponse = await fetch(coreBase + encodeURIComponent(teamId) + "/statistics", {
                  headers: { "Accept": "application/json" }
                });
                if (!coreResponse.ok) return null;
                const corePayload = await coreResponse.json();
                let rawStats = Array.isArray(corePayload?.statistics) ? corePayload.statistics : [];
                if (!rawStats.length && Array.isArray(corePayload?.splits?.categories)) {
                  rawStats = corePayload.splits.categories.flatMap(category =>
                    (Array.isArray(category?.stats) ? category.stats : []).map(stat => ({
                      ...stat, category: category.name || category.displayName
                    }))
                  );
                }
                if (!rawStats.length && Array.isArray(corePayload?.categories)) {
                  rawStats = corePayload.categories.flatMap(category =>
                    (Array.isArray(category?.stats) ? category.stats : [])
                  );
                }
                return rawStats.length ? { teamId, statistics: rawStats } : null;
              } catch (coreError) {
                console.log("ESPN Core team statistics fallback failed", item.fixtureId, teamId,
                  String(coreError?.message || coreError));
                return null;
              }
            }));
            if (coreResults.filter(Boolean).length === 2) {
              statistics = coreResults.map((result, index) => ({
                homeAway: competitors[index]?.homeAway || null,
                team: competitors[index]?.team?.displayName || competitors[index]?.team?.name || result.teamId,
                statistics: result.statistics
              }));
              hasActualStatistics = statistics.every(team => team.statistics.length > 0);
            }
          }
        }

        if (hasActualStatistics) {
          fetchedStatsJson = JSON.stringify({ teams: statistics, summaryAvailable: true, statisticsSource: "ESPN summary/core" });
          const statisticsWriteResult = await env.DB.prepare(
            "UPDATE matches SET statistics_json = ?, updated_at = CURRENT_TIMESTAMP WHERE source = 'ESPN' AND fixture_id = ? AND (statistics_json IS NULL OR statistics_json = '' OR statistics_json = 'null' OR json_valid(statistics_json) = 0 OR (CASE WHEN json_valid(statistics_json) = 1 THEN COALESCE(json_array_length(json_extract(statistics_json, '$.teams[0].statistics')), 0) ELSE 0 END = 0 OR CASE WHEN json_valid(statistics_json) = 1 THEN COALESCE(json_array_length(json_extract(statistics_json, '$.teams[1].statistics')), 0) ELSE 0 END = 0))"
          ).bind(fetchedStatsJson, item.fixtureId).run();
          const actualChanges = Number(statisticsWriteResult?.meta?.changes || 0);
          summaryDoneSet.add(item.key);
          summaryRun.fetchedWithStatistics++;
          summaryRun.saved += actualChanges;
        } else {
          summaryRun.noStatisticsReturned++;
          if (summaryRun.noStatisticsSamples.length < 10) {
            summaryRun.noStatisticsSamples.push({ fixtureId: item.fixtureId, slug: item.slug, eventId: item.eventId });
          }
          // Do not burn requests on unavailable box scores; retain and retry later.
          summaryRetries.push({
            ...item,
            attempts: 0,
            noStatsAttempts: Number(item.noStatsAttempts || 0) + 1,
            retryAfter: Date.now() + 24 * 60 * 60 * 1000
          });
        }
      } catch (error) {
        if (fetchedStatsJson) {
          const pendingEntry = { fixtureId: item.fixtureId, key: item.key, statisticsJson: fetchedStatsJson, fetchedAt: new Date().toISOString() };
          if (!pendingStats.some(entry => entry.fixtureId === item.fixtureId)) pendingStats.push(pendingEntry);
          await env.MAM_KV.put(pendingStatsKey, JSON.stringify(pendingStats));
          summaryRun.fetchedWithStatistics++;
          summaryRun.requestFailureSamples.push({ fixtureId: item.fixtureId, error: "Box score downloaded; D1 write deferred to KV pending queue" });
          console.log("ESPN box score buffered in KV because D1 write failed", item.fixtureId, String(error?.message || error));
        } else {
          summaryRun.requestFailures++;
        }
        if (!fetchedStatsJson && summaryRun.requestFailureSamples.length < 10) {
          summaryRun.requestFailureSamples.push({
            fixtureId: item.fixtureId, slug: item.slug, eventId: item.eventId,
            error: String(error?.message || error).slice(0, 240)
          });
        }
        const retryAfterSeconds = retryAfterHeader
          ? (Number.isFinite(Number(retryAfterHeader))
              ? Math.max(60, Number(retryAfterHeader))
              : Math.max(60, Math.ceil((Date.parse(retryAfterHeader) - Date.now()) / 1000)))
          : 0;
        const attempt = Number(item.attempts || 0) + 1;
        const fallbackDelayMs = Math.min(12 * 60 * 60 * 1000, 15 * 60 * 1000 * Math.pow(2, Math.min(attempt - 1, 3)));
        const delayMs = retryAfterSeconds > 0
          ? Math.min(24 * 60 * 60 * 1000, retryAfterSeconds * 1000)
          : fallbackDelayMs;
        if (!fetchedStatsJson) {
          summaryRetries.push({ ...item, attempts: attempt, retryAfter: Date.now() + delayMs });
          console.log("ESPN match statistics sync failed", item.fixtureId, String(error?.message || error));
        }
      }
    }));
  }
  if (summaryRetries.length) summaryQueue.push(...summaryRetries);
  // Keep the oldest pending items first; newer overflow can be rediscovered from D1.
  if (summaryQueue.length > 500) summaryQueue = summaryQueue.slice(0, 500);
  await env.MAM_KV.put(summaryQueueKey, JSON.stringify(summaryQueue));
  summaryRun.pendingAfterRun = summaryQueue.length;
  if (env.MAM_KV) await env.MAM_KV.put("mam:espn-summary-last-run:v1", JSON.stringify(summaryRun), { expirationTtl: 60 * 60 * 24 * 30 });
  console.log("ESPN summary processing report", summaryRun);
  const doneList = Array.from(summaryDoneSet);
  await env.MAM_KV.put(summaryDoneKey, JSON.stringify(doneList.slice(-3000)));

  state.cursor += batch.length;
  if (retryJobs.length) state.jobs.push(...retryJobs);
  const complete = state.cursor >= state.jobs.length;
  // Keep the completed cursor as a durable checkpoint. Deleting this key
  // makes the next 5-minute cron invocation rebuild the entire 1,081-day queue.
  // The next run can extend this completed prefix with only newly-entered dates.
  await env.MAM_KV.put(stateKey, JSON.stringify(state));
  if (maxRequests > 10) {
    const summaryFailures = Number(summaryRun.requestFailures || 0);
    const pendingD1WriteFailure = pendingStats.length > 0 && summaryRun.requestFailureSamples.some(sample =>
      String(sample?.error || "").includes("D1 write deferred")
    );
    const healthy = failed === 0 && !archiveWriteBlocked && summaryFailures === 0 && !pendingD1WriteFailure;
    adaptiveSpeed = {
      requests: effectiveMaxRequests,
      healthyRuns: healthy ? Number(adaptiveSpeed.healthyRuns || 0) + 1 : 0,
      lastFailed: failed,
      lastArchiveWriteBlocked: archiveWriteBlocked,
      lastSummaryFailures: summaryFailures,
      lastPendingD1WriteFailure: pendingD1WriteFailure,
      lastRunAt: new Date().toISOString()
    };
    await env.MAM_KV.put(adaptiveSpeedKey, JSON.stringify(adaptiveSpeed), { expirationTtl: 60 * 60 * 24 * 30 });
  }
  console.log("ESPN D1 archive sync batch", {
    saved, failed, processed: batch.length, totalJobs: state.jobs.length,
    nextCursor: complete ? null : state.cursor, complete, retryQueued: retryJobs.length,
    summariesProcessed: summaryBatch.length, summariesPending: summaryQueue.length,
    adaptiveRequests: effectiveMaxRequests
  });
  if (complete) console.log("ESPN D1 archive sync complete", { saved, failed, leagues: leagues.length });
  return { saved, failed, complete, processed: batch.length, nextCursor: complete ? null : state.cursor };
}

async function buildPriorityLeagueStatus(env) {
  if (!env.DB) throw new Error("D1 binding DB is missing");
  const sql = `
          WITH priority(league_id, league_name, priority_order) AS (
            VALUES
              ('39', 'İngiltere Premier League', 1),
              ('203', 'Türkiye Süper Lig', 2),
              ('140', 'İspanya La Liga', 3),
              ('78', 'Almanya Bundesliga', 4),
              ('135', 'İtalya Serie A', 5),
              ('61', 'Fransa Ligue 1', 6),
              ('2', 'UEFA Şampiyonlar Ligi', 7),
              ('3', 'UEFA Avrupa Ligi', 8),
              ('88', 'Hollanda Eredivisie', 9),
              ('94', 'Portekiz Primeira Liga', 10)
          ),
          scoped AS (
            SELECT CAST(league_id AS TEXT) AS league_id, source, kickoff, status,
                   home_team, away_team, home_goals, away_goals, statistics_json
            FROM matches
            WHERE CAST(league_id AS TEXT) IN ('39','203','140','78','135','61','2','3','88','94')
          ),
          deduplicated AS (
            SELECT * FROM (
              SELECT *,
                     ROW_NUMBER() OVER (
                       PARTITION BY league_id,
                       CASE WHEN COALESCE(trim(kickoff),'') = '' OR COALESCE(trim(home_team),'') = '' OR COALESCE(trim(away_team),'') = ''
                         THEN source || ':' || fixture_id ELSE kickoff END,
                       CASE WHEN COALESCE(trim(kickoff),'') = '' OR COALESCE(trim(home_team),'') = '' OR COALESCE(trim(away_team),'') = ''
                         THEN source || ':' || fixture_id ELSE lower(trim(home_team)) END,
                       CASE WHEN COALESCE(trim(kickoff),'') = '' OR COALESCE(trim(home_team),'') = '' OR COALESCE(trim(away_team),'') = ''
                         THEN source || ':' || fixture_id ELSE lower(trim(away_team)) END
                       ORDER BY
                         CASE WHEN statistics_json IS NOT NULL
                           AND statistics_json <> '' AND statistics_json <> 'null'
                           AND json_valid(statistics_json) = 1
                           AND json_type(statistics_json, '$.teams') = 'array'
                           AND json_array_length(statistics_json, '$.teams') >= 2
                           AND json_array_length(statistics_json, '$.teams[0].statistics') > 0
                           AND json_array_length(statistics_json, '$.teams[1].statistics') > 0
                           THEN 0 ELSE 1 END,
                         source ASC
                     ) AS duplicate_rank
              FROM scoped
            )
            WHERE duplicate_rank = 1
          ),
          completed AS (
            SELECT * FROM deduplicated
            WHERE UPPER(COALESCE(status,'')) IN ('FT','AET','PEN','FINISHED','COMPLETED')
              AND home_goals IS NOT NULL AND away_goals IS NOT NULL
          ),
          team_appearances AS (
            SELECT league_id, home_team AS team_name, kickoff, home_team, away_team,
                   statistics_json, source
            FROM completed WHERE COALESCE(home_team,'') <> ''
            UNION ALL
            SELECT league_id, away_team AS team_name, kickoff, home_team, away_team,
                   statistics_json, source
            FROM completed WHERE COALESCE(away_team,'') <> ''
          ),
          ranked_appearances AS (
            SELECT *, ROW_NUMBER() OVER (
              PARTITION BY league_id, team_name ORDER BY kickoff DESC, home_team, away_team
            ) AS recent_rank
            FROM team_appearances
          ),
          recent_team_summary AS (
            SELECT league_id, team_name, COUNT(*) AS recent_games,
                   SUM(CASE WHEN statistics_json IS NOT NULL
                     AND statistics_json <> '' AND statistics_json <> 'null'
                     AND json_valid(statistics_json) = 1
                     AND json_type(statistics_json, '$.teams') = 'array'
                     AND json_array_length(statistics_json, '$.teams') >= 2
                     AND json_array_length(statistics_json, '$.teams[0].statistics') > 0
                     AND json_array_length(statistics_json, '$.teams[1].statistics') > 0
                     THEN 1 ELSE 0 END) AS recent_games_with_real_stats
            FROM ranked_appearances
            WHERE recent_rank <= 10
            GROUP BY league_id, team_name
          ),
          recent_league_summary AS (
            SELECT league_id, COUNT(*) AS teams_checked,
                   SUM(CASE WHEN recent_games >= 10 THEN 1 ELSE 0 END) AS teams_with_10_recent,
                   SUM(CASE WHEN recent_games < 10 THEN 10 - recent_games ELSE 0 END) AS missing_recent_team_games,
                   SUM(recent_games) AS recent_team_appearances,
                   SUM(recent_games_with_real_stats) AS recent_team_appearances_with_stats,
                   SUM(recent_games - recent_games_with_real_stats) AS recent_team_appearances_missing_stats
            FROM recent_team_summary GROUP BY league_id
          ),
          team_games AS (
            SELECT league_id, team_name,
                   COUNT(*) AS games
            FROM team_appearances
            GROUP BY league_id, team_name
          ),
          team_summary AS (
            SELECT league_id, COUNT(*) AS team_count,
                   SUM(CASE WHEN games >= 10 THEN 1 ELSE 0 END) AS teams_with_10,
                   MIN(games) AS min_team_games,
                   MAX(games) AS max_team_games
            FROM team_games GROUP BY league_id
          ),
          league_summary AS (
            SELECT league_id,
                   COUNT(*) AS archived_rows,
                   SUM(CASE WHEN UPPER(COALESCE(status,'')) IN ('FT','AET','PEN','FINISHED','COMPLETED')
                             AND (home_goals IS NULL OR away_goals IS NULL) THEN 1 ELSE 0 END) AS completed_missing_score,
                   SUM(CASE WHEN UPPER(COALESCE(status,'')) IN ('NS','TBD','PST','SCHEDULED') THEN 1 ELSE 0 END) AS upcoming_rows,
                   COUNT(DISTINCT source) AS source_count,
                   SUM(CASE WHEN statistics_json IS NOT NULL AND statistics_json <> '' AND statistics_json <> 'null'
                             AND json_valid(statistics_json) = 1
                             AND json_type(statistics_json, '$.teams') = 'array'
                             AND json_array_length(statistics_json, '$.teams') >= 2
                             AND json_array_length(statistics_json, '$.teams[0].statistics') > 0
                             AND json_array_length(statistics_json, '$.teams[1].statistics') > 0
                             THEN 1 ELSE 0 END) AS rows_with_statistics_payload
            FROM scoped GROUP BY league_id
          )
          SELECT p.league_id, p.league_name, p.priority_order,
                 COALESCE(l.archived_rows,0) AS archived_rows,
                 COALESCE(l.upcoming_rows,0) AS upcoming_rows,
                 COALESCE(l.completed_missing_score,0) AS completed_missing_score,
                 COALESCE(l.source_count,0) AS source_count,
                 COALESCE(l.rows_with_statistics_payload,0) AS rows_with_statistics_payload,
                 COALESCE(t.team_count,0) AS team_count,
                 COALESCE(t.teams_with_10,0) AS teams_with_10,
                 t.min_team_games, t.max_team_games,
                 COALESCE(r.teams_checked,0) AS teams_checked_for_recent_10,
                 COALESCE(r.teams_with_10_recent,0) AS teams_with_10_recent,
                 COALESCE(r.missing_recent_team_games,0) AS missing_recent_team_games,
                 COALESCE(r.recent_team_appearances,0) AS recent_team_appearances,
                 COALESCE(r.recent_team_appearances_with_stats,0) AS recent_team_appearances_with_stats,
                 COALESCE(r.recent_team_appearances_missing_stats,0) AS recent_team_appearances_missing_stats
          FROM priority p
          LEFT JOIN league_summary l ON l.league_id = p.league_id
          LEFT JOIN team_summary t ON t.league_id = p.league_id
          LEFT JOIN recent_league_summary r ON r.league_id = p.league_id
          ORDER BY p.priority_order
        `;
  const result = await env.DB.prepare(sql).all();
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    scope: "ten-priority-leagues",
    verificationLevel: "per-team-recent-10-coverage",
    leagues: Array.isArray(result?.results) ? result.results : [],
    note: "Recent-10 coverage is measured per team from archived completed fixtures. Statistics are counted only when both teams have non-empty statistics arrays in the stored teams payload. This does not independently prove historical fixture completeness beyond the available archive or live-score accuracy."
  };
}

export default {
  // Daily TFF fixture sync: one KV write per run, keeping free-tier writes low.
  async scheduled(event, env, ctx) {
    // Single 15-minute cron trigger avoids account-wide trigger limits. Keep daily
    // maintenance on the 03:00 UTC quarter-hour invocation.
    const scheduledAt = new Date();
    const isDailySync = scheduledAt.getUTCHours() === 3 && scheduledAt.getUTCMinutes() === 0;
    const isHourlySync = !isDailySync;
    if (env.DB) {
      // Maintenance is optional and must NEVER prevent the archive/summary worker
      // from running. D1 quota errors in maintenance are isolated from ingestion.
      try {
        const maintenanceKey = "mam:d1-maintenance-last:v3";
        const lastMaintenanceAt = Number(env.MAM_KV ? await env.MAM_KV.get(maintenanceKey) : 0);
        if (!lastMaintenanceAt || Date.now() - lastMaintenanceAt >= 24 * 60 * 60 * 1000) {
          await ensureArchiveIndexes(env);
          if (env.MAM_KV) await env.MAM_KV.put(maintenanceKey, String(Date.now()), { expirationTtl: 60 * 60 * 48 });
        }
      } catch (maintenanceError) {
        console.log("D1 maintenance skipped; archive and summary sync will continue", String(maintenanceError?.message || maintenanceError));
      }

      try {
        await syncEspnFixturesToD1(env, 900, 180, isHourlySync ? 32 : 10);
      } catch (archiveError) {
        console.log("ESPN archive/summary sync error", String(archiveError?.message || archiveError));
      }

      if (isDailySync && env.MAM_KV) {
        try {
          const report = await buildPriorityLeagueStatus(env);
          await env.MAM_KV.put("mam:priority-league-status:v3", JSON.stringify(report), { expirationTtl: 60 * 60 * 48 });
          console.log("Daily priority league archive quality check", {
            generatedAt: report.generatedAt, leagues: report.leagues.length
          });
        } catch (qualityError) {
          console.log("Daily priority league archive quality check failed", String(qualityError?.message || qualityError));
        }
      }

      try {
        const enrichmentThrottleKey = "mam:cross-source-enrichment-last:v4";
        const lastEnrichmentAt = Number(env.MAM_KV ? await env.MAM_KV.get(enrichmentThrottleKey) : 0);
        if (!lastEnrichmentAt || Date.now() - lastEnrichmentAt >= 6 * 60 * 60 * 1000) {
          const crossSourceStats = await enrichExactCrossSourceMatches(env);
          console.log("Scheduled cross-source statistics enrichment", crossSourceStats);
          if (env.MAM_KV) await env.MAM_KV.put(enrichmentThrottleKey, String(Date.now()), { expirationTtl: 60 * 60 * 48 });
        }
      } catch (enrichmentError) {
        const report = {
          ranAt: new Date().toISOString(),
          target: "ESPN rows missing either team's statistics",
          error: String(enrichmentError?.message || enrichmentError),
          stage: "scheduled-cross-source-enrichment"
        };
        if (env.MAM_KV) {
          await env.MAM_KV.put("mam:cross-source-stats:last:v3", JSON.stringify(report), { expirationTtl: 60 * 60 * 24 * 30 });
          // Back off after D1 quota/read errors too. Without this checkpoint,
          // every 15-minute cron run retries the same expensive full-table scan.
          await env.MAM_KV.put("mam:cross-source-enrichment-last:v4", String(Date.now()), { expirationTtl: 60 * 60 * 48 });
        }
        console.log("Cross-source statistics enrichment failed", report);
      }
    }
    if (isHourlySync || !env.MAM_KV) return;
    const now = new Date();
    const fixtures = [];
    const seen = new Set();
    const decode = value => String(value || "")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&uuml;/gi, "ü").replace(/&Uuml;/g, "Ü")
      .replace(/&ouml;/gi, "ö").replace(/&Ouml;/g, "Ö")
      .replace(/&ccedil;/gi, "ç").replace(/&Ccedil;/g, "Ç")
      .replace(/&gbreve;/gi, "ğ").replace(/&Gbreve;/g, "Ğ")
      .replace(/&scedil;/gi, "ş").replace(/&Scedil;/g, "Ş")
      .replace(/&inodot;/gi, "ı").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
    const cleanTeam = value => {
      const raw = decode(value).replace(/\s+/g, " ").replace(/\s*\.\s*/g, ".").trim();
      const key = normalizeTeamName(raw).replace(/-a-s$/, "").replace(/-as$/, "");
      const aliases = {
        "galatasaray": "Galatasaray", "fenerbahce": "Fenerbahçe",
        "besiktas": "Beşiktaş", "samsunspor": "Samsunspor",
        "kasimpasa": "Kasımpaşa", "trabzonspor": "Trabzonspor",
        "genclerbirligi": "Gençlerbirliği", "tumosankonyaspor": "Konyaspor",
        "corendon-alanyaspor": "Alanyaspor", "caykur-rizespor": "Çaykur Rizespor",
        "gaziantep-futbol-kulubu": "Gaziantep FK", "amed-sportif-faaliyetler": "Amedspor",
        "arca-corum-fk": "Çorum FK", "erzurumspor-fk": "Erzurum BB",
        "istanbul-basaksehir-fk": "Başakşehir", "goztepe": "Göztepe",
        "eyupspor": "Eyüpspor", "kocaelispor": "Kocaelispor"
      };
      return aliases[key] || raw.replace(/\s+A\.Ş\.$/i, "").trim();
    };
    for (let start = 1; start <= 34; start += 4) {
      const batch = [];
      for (let round = start; round < Math.min(start + 4, 35); round++) {
        batch.push((async () => {
          const response = await fetch("https://www.tff.org/Default.aspx?hafta=" + round + "&pageID=198", {
            headers: { "Accept": "text/html", "User-Agent": "Mozilla/5.0 MaçAnalizMerkezi/1.0" }
          });
          if (!response.ok) throw new Error("TFF hafta " + round + " HTTP " + response.status);
          const html = await response.text();
          const text = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
          const re = /(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}:\d{2})\s+(.+?)\s+-\s+(.+?)(?=\s+Detaylar|\s+\d{2}\.\d{2}\.\d{4}|$)/g;
          let match;
          while ((match = re.exec(text)) !== null) {
            const [, day, month, year, time, homeRaw, awayRaw] = match;
            const home = cleanTeam(homeRaw), away = cleanTeam(awayRaw);
            if (!home || !away || home.length > 70 || away.length > 70) continue;
            const iso = year + "-" + month + "-" + day + "T" + time + ":00+03:00";
            const timestamp = Date.parse(iso);
            if (!Number.isFinite(timestamp) || timestamp < now.getTime() - 3 * 60 * 60 * 1000) continue;
            const id = "tff-" + year + month + day + "-" + normalizeTeamName(home) + "-" + normalizeTeamName(away);
            if (seen.has(id)) continue;
            seen.add(id);
            fixtures.push({
              fixture: { id, date: iso, status: { short: "NS", elapsed: null } },
              league: { id: 203, name: "Trendyol Süper Lig", country: "Türkiye", round: round + ". Hafta" },
              teams: { home: { id: null, name: home }, away: { id: null, name: away } },
              goals: { home: null, away: null },
              _source: "TFF"
            });
          }
        })());
      }
      const results = await Promise.allSettled(batch);
      if (results.some(result => result.status === "rejected")) {
        // Do not replace a valid previous snapshot with a partial scrape.
        throw new Error("TFF fikstür taramasında hafta hatası: " + results.filter(x => x.status === "rejected").map(x => x.reason?.message || "bilinmeyen hata").join("; "));
      }
    }
    fixtures.sort((a, b) => Date.parse(a.fixture.date) - Date.parse(b.fixture.date));
    if (fixtures.length < 9) throw new Error("TFF taramasında beklenen sayıda gelecek maç bulunamadı: " + fixtures.length);
    const snapshot = { source: "TFF", season: "2026/2027", updatedAt: new Date().toISOString(), count: fixtures.length, fixtures };
    // D1 kalıcı fikstür arşivi: mevcut KV snapshot'ını koruyarak aynı maçları güvenli biçimde güncelle.
    if (env.DB) {
      let tffD1Updated = false;
      try {
        const sql = `INSERT INTO matches
          (source, fixture_id, league_id, league_name, country, kickoff, status,
           home_team_id, home_team, away_team_id, away_team, home_goals, away_goals,
           statistics_json, raw_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source, fixture_id) DO UPDATE SET
           league_id=excluded.league_id, league_name=excluded.league_name,
           country=excluded.country, kickoff=excluded.kickoff, status=excluded.status,
           home_team=excluded.home_team, away_team=excluded.away_team,
           raw_json=excluded.raw_json, updated_at=CURRENT_TIMESTAMP`;
        const statements = fixtures.map(m => env.DB.prepare(sql).bind(
          "TFF", String(m.fixture.id), "203", "Trendyol Süper Lig", "Türkiye",
          String(m.fixture.date), "NS", null, String(m.teams.home.name), null,
          String(m.teams.away.name), null, null, null, JSON.stringify(m)
        ));
        for (let i = 0; i < statements.length; i += 50) {
          await env.DB.batch(statements.slice(i, i + 50));
        }
        tffD1Updated = true;
      } catch (d1Error) {
        // D1 geçici hata verse bile mevcut TFF KV fikstür servisi çalışmaya devam etsin.
        console.log("TFF D1 fixture sync failed; preserving existing archive rows", String(d1Error?.message || d1Error));
      }
      if (tffD1Updated) {
        try { await env.MAM_KV.delete("mam:half-goals:v1:" + new Date().toISOString().slice(0, 13)); }
        catch (cacheError) { console.log("Half-goals cache invalidation failed after TFF sync", String(cacheError?.message || cacheError)); }
      }
    }
    await env.MAM_KV.put("superlig:fixtures:2026-27", JSON.stringify(snapshot));
  },
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    // Allow the production GitHub Pages app and Cloudflare's own dashboard
    // HTTP test panel. All other browser origins remain blocked.
    const allowedOrigins = new Set([ALLOWED_ORIGIN, "https://dash.cloudflare.com"]);
    const cors = {
      "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };

    if (origin && !allowedOrigins.has(origin)) {
      return new Response("Origin not allowed", { status: 403, headers: cors });
    }


    const headers = { ...cors, "Content-Type": "application/json; charset=utf-8" };
    const url = new URL(request.url);
    if (url.pathname === "/auth/login" && request.method === "POST") {
      if (!env.SITE_PASSWORD || !env.SESSION_SECRET) {
        return new Response(JSON.stringify({ error: "Authentication secrets are not configured" }), { status: 503, headers });
      }
      let body = {};
      try { body = await request.json(); } catch (_) {}
      if (typeof body.password !== "string" || body.password !== env.SITE_PASSWORD) {
        return new Response(JSON.stringify({ error: "Wrong password" }), { status: 401, headers });
      }
      const token = await createSessionToken(env.SESSION_SECRET);
      return new Response(JSON.stringify({ token, expiresIn: 90 * 24 * 60 * 60 }), { status: 200, headers });
    }
    if (url.pathname === "/auth/check" && request.method === "GET") {
      const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
      const ok = await verifySessionToken(token, env.SESSION_SECRET);
      return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 401, headers });
    }

    const requestUrl = new URL(request.url);
    // Friendly root response: opening the Worker base URL should not produce "Invalid API path".
    if (request.method === "GET" &&
        (!requestUrl.pathname.startsWith("/api/") ||
         requestUrl.pathname === "/api" ||
         requestUrl.pathname === "/api/")) {
      return new Response(JSON.stringify({
        ok: true,
        service: "Maç Analiz Merkezi Worker",
        requestPath: requestUrl.pathname,
        endpoints: ["/api/archive/d1-status", "/api/archive/upcoming?days=30", "/api/archive/matches?league=39&before=2026-11-13&limit=50"],
        note: "Worker is online. Read-only archive endpoints are public; archive writes still require a valid session."
      }), { status: 200, headers });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "GET" && !(request.method === "POST" && requestUrl.pathname === "/api/archive/matches")) {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }

    try {
      const url = new URL(request.url);

      if (!url.pathname.startsWith("/api/")) {
        return new Response("Invalid API path", {
          status: 400,
          headers: cors
        });
      }

      const path = url.pathname.replace(/^\/api\//, "").replace(/\/+$/, "");

      const isESPN = path.startsWith("espn/");
      const isFootballStatus = path === "football/status";
      const isFixtureDownload = path.startsWith("fixturesdownload/");
      const isSportScore = path.startsWith("sportscore/");
      const validESPNPath = /^espn\/[a-zA-Z0-9._-]+\/(?:scoreboard|summary|standings|teams|teams\/[0-9]+\/schedule)$/.test(path) && ( !path.endsWith("/summary") || /^\d+$/.test(url.searchParams.get("event") || "") );
      const validFixtureDownloadPath = /^fixturesdownload\/(?:champions-league|europa-league|conference-league)-20(?:24|25|26|27)$/.test(path);
      const validSportScorePath = /^sportscore\/(?:widget\/(?:matches|match|team)|v1\/(?:fixtures|search))$/.test(path);
      const validStandardPath = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path);

      if (!(isESPN ? validESPNPath : isFixtureDownload ? validFixtureDownloadPath : isSportScore ? validSportScorePath : validStandardPath)) {
        return new Response("Invalid API path", {
          status: 400,
          headers: cors
        });
      }

      // Read-only match archive and aggregate diagnostics are public.
      // Writes and all other private routes still require a signed-in session.
      const publicArchiveRead = request.method === "GET" &&
        (path === "archive/d1-status" || path === "archive/sync-status" || path === "archive/matches" || path === "archive/upcoming" || path === "archive/priority-league-status" || path === "archive/quality-check" || path === "archive/live" ||
         isESPN || isFixtureDownload || isSportScore);
      if (!publicArchiveRead) {
        const sessionToken = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
        if (!(await verifySessionToken(sessionToken, env.SESSION_SECRET))) {
          return new Response(JSON.stringify({ error: "Authentication required" }), {
            status: 401, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" }
          });
        }
      }

      if (path === "archive/sync-status" && request.method === "GET") {
        if (!env.MAM_KV) {
          return new Response(JSON.stringify({ error: "MAM_KV KV binding is missing" }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const syncStatusCacheKey = "mam:sync-status-cache:v2";
        const forceFreshSyncStatus = new URL(request.url).searchParams.get("fresh") === "1";
        const cachedSyncStatus = forceFreshSyncStatus ? null : await env.MAM_KV.get(syncStatusCacheKey);
        if (cachedSyncStatus) {
          return new Response(cachedSyncStatus, {
            status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
          });
        }
        // Never scan the matches table from this 15-minute telemetry endpoint.
        // Reuse the six-hour D1 aggregate snapshot; this endpoint's job is to
        // report KV queue progress without consuming another full-table read.
        const [state, queueValue, lastSummaryRun, crossSourceStatsRun, adaptiveSpeedStatus, cachedD1StatusRaw] = await Promise.all([
          env.MAM_KV.get("mam:espn-sync-state:v2", "json"),
          env.MAM_KV.get("mam:espn-summary-queue:v1", "json"),
          env.MAM_KV.get("mam:espn-summary-last-run:v1", "json"),
          env.MAM_KV.get("mam:cross-source-stats:last:v3", "json"),
          env.MAM_KV.get("mam:espn-adaptive-speed:v1", "json"),
          env.MAM_KV.get("mam:d1-status-cache:v2")
        ]);
        let missingStatisticsInD1 = null;
        let missingStatisticsCountUpdatedAt = null;
        try {
          const cachedD1Status = cachedD1StatusRaw ? JSON.parse(cachedD1StatusRaw) : null;
          if (Array.isArray(cachedD1Status?.missingStatisticsBySource)) {
            const espnMissing = cachedD1Status.missingStatisticsBySource.find(item =>
              String(item?.source || "").toUpperCase() === "ESPN"
            );
            missingStatisticsInD1 = Number(espnMissing?.missing || 0);
            missingStatisticsCountUpdatedAt = cachedD1Status.lastUpdated || null;
          }
        } catch (_) { /* Keep the count unknown rather than issuing an expensive fallback scan. */ }
        const jobs = Array.isArray(state?.jobs) ? state.jobs.length : 0;
        const cursor = Number(state?.cursor || 0);
        const scoreboardActive = jobs > 0 && cursor < jobs;
        const queue = Array.isArray(queueValue) ? queueValue : [];
        const now = Date.now();
        const readyToRetry = queue.filter(item => Number(item?.retryAfter || 0) <= now).length;
        const coolingDown = queue.length - readyToRetry;
        const missingStatsSample = [];
        const active = scoreboardActive || queue.length > 0 || missingStatisticsInD1 === null || missingStatisticsInD1 > 0;
        const syncStatusReport = {
          ok: true,
          active,
          complete: !active,
          createdAt: state?.createdAt || null,
          totalJobs: jobs,
          processedJobs: Math.min(cursor, jobs),
          remainingJobs: Math.max(0, jobs - cursor),
          // progressPercent describes the whole archive+statistics job; never report 100%
          // while missing ESPN statistics remain. fixtureProgressPercent is scan-only.
          progressPercent: jobs
            ? Math.round(Math.min(cursor, jobs) / jobs * 1000) / 10
            : (active ? 0 : 100),
          fixtureProgressPercent: jobs ? Math.round(Math.min(cursor, jobs) / jobs * 1000) / 10 : 100,
          scoreboardActive,
          scoreboardComplete: !scoreboardActive,
          statisticsQueuePending: queue.length,
          missingStatisticsInD1,
          missingStatisticsCountUpdatedAt,
          statisticsReadyToRetry: readyToRetry,
          statisticsCoolingDown: coolingDown,
          adaptiveSpeed: adaptiveSpeedStatus || { requests: 20, healthyRuns: 0, mode: "starting" },
          summaryQueueSample: queue.slice(0, 25).map(item => ({
            fixtureId: item.fixtureId || null,
            slug: item.slug || null,
            attempts: Number(item.attempts || 0),
            noStatsAttempts: Number(item.noStatsAttempts || 0),
            retryAfter: Number(item.retryAfter || 0),
            cooldownAccelerated: item.cooldownAccelerated === true
          })),
          missingStatisticsSample: (missingStatsSample?.results || []).map(row => ({
            fixtureId: row.fixtureId, leagueId: row.leagueId, leagueName: row.leagueName,
            kickoff: row.kickoff, homeTeam: row.homeTeam, awayTeam: row.awayTeam, status: row.status,
            queued: queue.some(item => item.fixtureId === row.fixtureId),
            retryAfter: queue.find(item => item.fixtureId === row.fixtureId)?.retryAfter || null
          })),
          lastSummaryRun: lastSummaryRun || null,
          crossSourceStatsRun: crossSourceStatsRun || null,
          note: scoreboardActive
            ? "ESPN fixture archive scan is in progress"
            : queue.length || missingStatisticsInD1 > 0
              ? "Fixture scan is complete or between batches; missing statistics remain in the archive and are being retried"
              : "Fixture scan and statistics retry queue are clear"
        };
        const syncStatusBody = JSON.stringify(syncStatusReport);
        await env.MAM_KV.put(syncStatusCacheKey, syncStatusBody, { expirationTtl: 900 });
        return new Response(syncStatusBody, {
          status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
        });
      }

      if (path === "archive/priority-league-status" && request.method === "GET") {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: "D1 binding DB is missing" }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" }
          });
        }
        // Daily cron precomputes this report; public reads use KV and avoid rescanning D1.
        const cacheKey = "mam:priority-league-status:v3";
        const cached = env.MAM_KV ? await env.MAM_KV.get(cacheKey) : null;
        if (cached) {
          return new Response(cached, {
            status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
          });
        }
        try {
          const report = await buildPriorityLeagueStatus(env);
          const body = JSON.stringify(report);
          if (env.MAM_KV) {
            try { await env.MAM_KV.put(cacheKey, body, { expirationTtl: 60 * 60 * 48 }); } catch (_) {}
          }
          return new Response(body, {
            status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
          });
        } catch (error) {
          return new Response(JSON.stringify({ error: "Priority league archive check failed", detail: String(error?.message || error) }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" }
          });
        }
      }

      if (path === "archive/quality-check" && request.method === "GET") {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: "D1 binding DB is missing" }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        // Full archive audit by default (not just upcoming fixtures). Use scope=upcoming
        // only when an explicitly limited forward-looking check is desired.
        const scope = String(url.searchParams.get("scope") || "all").toLowerCase();
        const limitValue = Number.parseInt(url.searchParams.get("limit") || "3000", 10);
        const limit = Number.isFinite(limitValue) ? Math.max(100, Math.min(20000, limitValue)) : 10000;
        const daysValue = Number.parseInt(url.searchParams.get("days") || "30", 10);
        const days = Number.isFinite(daysValue) ? Math.max(1, Math.min(60, daysValue)) : 30;
        const qualityCacheKey = "mam:quality-check-cache:v6:" + new Date().toISOString().slice(0,10) + ":" + scope + ":" + days + ":" + limit;
        const cachedQualityReport = env.MAM_KV ? await env.MAM_KV.get(qualityCacheKey) : null;
        if (cachedQualityReport) {
          return new Response(cachedQualityReport, {
            status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
          });
        }
        const where = scope === "upcoming"
          ? "WHERE date(kickoff) >= date('now') AND date(kickoff) <= date('now', '+' || ? || ' days') AND status IN ('NS','TBD','SCHEDULED')"
          : "";
        const countQuery = scope === "upcoming"
          ? env.DB.prepare("SELECT COUNT(*) AS total FROM matches " + where).bind(days)
          : env.DB.prepare("SELECT COUNT(*) AS total FROM matches");
        const rowsQuery = scope === "upcoming"
          ? env.DB.prepare("SELECT source, fixture_id, league_id, league_name, country, kickoff, status, home_team, away_team, home_goals, away_goals, statistics_json FROM matches " + where + " ORDER BY datetime(kickoff) DESC LIMIT ?").bind(days, limit)
          : env.DB.prepare("SELECT source, fixture_id, league_id, league_name, country, kickoff, status, home_team, away_team, home_goals, away_goals, statistics_json FROM matches ORDER BY datetime(kickoff) DESC LIMIT ?").bind(limit);
        const [countResult, rowsResult] = await Promise.all([countQuery.first(), rowsQuery.all()]);
        const rows = Array.isArray(rowsResult?.results) ? rowsResult.results : [];
        const totalRecords = Number(countResult?.total || 0);
        const norm = value => String(value || "").normalize("NFD").toLowerCase()
          .replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i")
          .replace(/[^a-z0-9]+/g, "").trim();
        const duplicateMap = new Map();
        const leagueMap = new Map();
        const sourceCounts = {};
        const invalidRecords = [];
        const completedWithoutScore = [];
        const malformedStatistics = [];
        const missingStatisticsBySource = {};
        let missingStatistics = 0;
        let validStatistics = 0;
        let invalidScoreCount = 0;
        let invalidRecordCount = 0;
        let completedWithoutScoreCount = 0;
        let malformedStatisticsCount = 0;
        for (const row of rows) {
          const source = String(row.source || "unknown");
          sourceCounts[source] = (sourceCounts[source] || 0) + 1;
          const leagueId = String(row.league_id || "unknown");
          const leagueKey = source + "|" + leagueId;
          const leagueName = String(row.league_name || "").trim();
          const country = String(row.country || "").trim();
          if (!leagueMap.has(leagueKey)) leagueMap.set(leagueKey, { source, leagueId, names: new Set(), countries: new Set(), count: 0 });
          const league = leagueMap.get(leagueKey);
          league.names.add(leagueName || "(boş)");
          league.countries.add(country || "(boş)");
          league.count++;
          const home = norm(row.home_team), away = norm(row.away_team);
          const kickoff = String(row.kickoff || "");
          const kickoffTime = Date.parse(kickoff);
          const status = String(row.status || "").toUpperCase();
          if (!home || !away || !kickoff || !Number.isFinite(kickoffTime) || !leagueName) {
            invalidRecordCount++;
            if (invalidRecords.length < 100) invalidRecords.push({ source, fixtureId: row.fixture_id, leagueId, leagueName, kickoff, home: row.home_team, away: row.away_team });
          }
          if (["FT", "AET", "PEN", "FINISHED", "COMPLETED", "AWD", "WO"].includes(status) && (row.home_goals == null || row.away_goals == null)) {
            completedWithoutScoreCount++;
            if (completedWithoutScore.length < 100) completedWithoutScore.push({ source, fixtureId: row.fixture_id, leagueId, kickoff, home: row.home_team, away: row.away_team, homeGoals: row.home_goals, awayGoals: row.away_goals });
          }
          if ((row.home_goals != null && (!Number.isFinite(Number(row.home_goals)) || Number(row.home_goals) < 0 || Number(row.home_goals) > 30)) ||
              (row.away_goals != null && (!Number.isFinite(Number(row.away_goals)) || Number(row.away_goals) < 0 || Number(row.away_goals) > 30))) invalidScoreCount++;
          const eligible = ["FT", "AET", "PEN", "FINISHED", "COMPLETED", "AWD", "WO", "LIVE", "1H", "2H", "HT", "ET", "P", "INT"].includes(status);
          if (eligible) {
            let usable = false;
            if (row.statistics_json && row.statistics_json !== "null") {
              try {
                const parsed = JSON.parse(row.statistics_json);
                usable = hasUsableStatistics(parsed);
              } catch (_) {
                malformedStatisticsCount++;
                if (malformedStatistics.length < 100) malformedStatistics.push({ source, fixtureId: row.fixture_id });
              }
            }
            if (usable) validStatistics++;
            else {
              missingStatistics++;
              missingStatisticsBySource[source] = (missingStatisticsBySource[source] || 0) + 1;
            }
          }
          if (home && away && Number.isFinite(kickoffTime)) {
            const minute = Math.floor(kickoffTime / 60000);
            const key = [minute, home, away].join("|");
            if (!duplicateMap.has(key)) duplicateMap.set(key, []);
            duplicateMap.get(key).push({ source, fixtureId: String(row.fixture_id || ""), leagueId, leagueName, country, kickoff, home: row.home_team, away: row.away_team });
          }
        }
        const duplicates = Array.from(duplicateMap.values())
          .filter(group => group.length > 1)
          .map(group => ({ copies: group.length, sources: Array.from(new Set(group.map(item => item.source))), records: group.slice(0, 10) }))
          .slice(0, 200);
        const leagueInconsistencies = Array.from(leagueMap.values())
          .filter(item => item.names.size > 1 || item.countries.size > 1)
          .map(item => ({ source: item.source, leagueId: item.leagueId, names: Array.from(item.names), countries: Array.from(item.countries), count: item.count }))
          .slice(0, 200);

        // Team-level coverage for the agreed priority competitions. UNION removes
        // duplicate provider rows for the same local match-day/team/opponent.
        // This measures teams observed in the archive; it does not invent missing teams.
        const priorityLeagueIds = ["39","203","140","78","135","61","2","3","88","94","848"];
        const leaguePlaceholders = priorityLeagueIds.map(() => "?").join(",");
        const [teamCoverageResult, upcomingCoverageResult, upcomingFixturesResult] = await Promise.all([
          env.DB.prepare(
            "WITH appearances AS (" +
            "SELECT league_id, date(kickoff) AS match_day, lower(trim(home_team)) AS team_name, lower(trim(away_team)) AS opponent_name " +
            "FROM matches WHERE league_id IN (" + leaguePlaceholders + ") AND status IN ('FT','AET','PEN','FINISHED','COMPLETED','AWD','WO') AND home_goals IS NOT NULL AND away_goals IS NOT NULL " +
            "UNION " +
            "SELECT league_id, date(kickoff) AS match_day, lower(trim(away_team)) AS team_name, lower(trim(home_team)) AS opponent_name " +
            "FROM matches WHERE league_id IN (" + leaguePlaceholders + ") AND status IN ('FT','AET','PEN','FINISHED','COMPLETED','AWD','WO') AND home_goals IS NOT NULL AND away_goals IS NOT NULL" +
            ") SELECT league_id AS leagueId, match_day AS matchDay, team_name AS teamName, opponent_name AS opponentName FROM appearances"
          ).bind(...priorityLeagueIds, ...priorityLeagueIds).all(),
          env.DB.prepare(
            "SELECT league_id AS leagueId, COUNT(DISTINCT date(kickoff) || '|' || lower(trim(home_team)) || '|' || lower(trim(away_team))) AS upcomingMatches FROM matches WHERE source = 'ESPN' AND league_id IN (" + leaguePlaceholders + ") AND status IN ('NS','TBD','SCHEDULED') AND date(kickoff) >= date('now') AND date(kickoff) <= date('now','+30 days') GROUP BY league_id"
          ).bind(...priorityLeagueIds).all(),
          env.DB.prepare(
            "SELECT league_id AS leagueId, date(kickoff) AS matchDay, home_team AS home, away_team AS away FROM matches WHERE source = 'ESPN' AND league_id IN (" + leaguePlaceholders + ") AND status IN ('NS','TBD','SCHEDULED') AND date(kickoff) >= date('now') AND date(kickoff) <= date('now','+30 days')"
          ).bind(...priorityLeagueIds).all()
        ]);
        const rawTeamAppearances = Array.isArray(teamCoverageResult?.results) ? teamCoverageResult.results : [];
        // Normalize club aliases and deduplicate provider copies before counting
        // appearances, so "Man Utd" and "Manchester United" are one team.
        const canonicalAppearanceKeys = new Set();
        const canonicalTeamCounts = new Map();
        for (const row of rawTeamAppearances) {
          const leagueId = String(row.leagueId || "");
          const teamKey = normalizeTeamName(row.teamName);
          const opponentKey = normalizeTeamName(row.opponentName);
          const matchDay = String(row.matchDay || "");
          if (!leagueId || !teamKey || !opponentKey || !matchDay) continue;
          const appearanceKey = [leagueId,matchDay,teamKey,opponentKey].join("|");
          if (canonicalAppearanceKeys.has(appearanceKey)) continue;
          canonicalAppearanceKeys.add(appearanceKey);
          const key = [leagueId,teamKey].join("|");
          const aggregate = canonicalTeamCounts.get(key) || {
            leagueId, teamName: String(row.teamName || "").trim(),
            completedMatches: 0, lastMatch: matchDay
          };
          aggregate.completedMatches++;
          if (matchDay > aggregate.lastMatch) aggregate.lastMatch = matchDay;
          canonicalTeamCounts.set(key,aggregate);
        }
        const teamCoverageRows = Array.from(canonicalTeamCounts.values());
        const upcomingCoverageRows = Array.isArray(upcomingCoverageResult?.results) ? upcomingCoverageResult.results : [];
        const upcomingFixtureRows = Array.isArray(upcomingFixturesResult?.results) ? upcomingFixturesResult.results : [];
        const upcomingByLeague = new Map(upcomingCoverageRows.map(row => [String(row.leagueId), Number(row.upcomingMatches || 0)]));
        const d1UpcomingByLeague = new Map();
        const auditName = value => normalizeTeamName(value).replace(/-(?:fc|afc|cf|sc|sk|fk)$/,"");
        for (const row of upcomingFixtureRows) {
          const id = String(row.leagueId);
          const list = d1UpcomingByLeague.get(id) || new Set();
          list.add([String(row.matchDay||""),auditName(row.home),auditName(row.away)].join("|"));
          d1UpcomingByLeague.set(id,list);
        }
        const priorityLeagueDefinitions = [
          ["39","eng.1","İngiltere Premier League"],["203","tur.1","Türkiye Süper Lig"],
          ["140","esp.1","İspanya La Liga"],["78","ger.1","Almanya Bundesliga"],
          ["135","ita.1","İtalya Serie A"],["61","fra.1","Fransa Ligue 1"],
          ["2","uefa.champions","UEFA Şampiyonlar Ligi"],["3","uefa.europa","UEFA Avrupa Ligi"],
          ["88","ned.1","Hollanda Eredivisie"],["94","por.1","Portekiz Primeira Liga"],
          ["848","uefa.europa.conf","UEFA Konferans Ligi"]
        ];
        const coverageNames = Object.fromEntries(priorityLeagueDefinitions.map(([id,slug,name]) => [id,name]));
        // Fetch the provider's current team directory so a team absent from D1
        // is visible as missing instead of disappearing from the denominator.
        const directoryResults = await Promise.allSettled(priorityLeagueDefinitions.map(async ([id,slug]) => {
          const auditStart = new Date();
          auditStart.setUTCHours(0,0,0,0);
          const auditEnd = new Date(auditStart);
          auditEnd.setUTCDate(auditEnd.getUTCDate()+30);
          // ESPN retired date-range scoreboard queries (they now return HTTP 400).
          // Request calendar months separately, then filter the combined events to
          // the exact audit window. This keeps the audit to at most two calls/league.
          const auditMonths = [];
          const monthCursor = new Date(Date.UTC(auditStart.getUTCFullYear(),auditStart.getUTCMonth(),1));
          while (monthCursor <= auditEnd) {
            auditMonths.push(monthCursor.toISOString().slice(0,7).replace(/-/g,""));
            monthCursor.setUTCMonth(monthCursor.getUTCMonth()+1);
          }
          const [teamResponse,scoreboardResponses] = await Promise.all([
            fetch(ESPN_BASE + "/" + slug + "/teams?limit=500", { headers: { "Accept": "application/json" } }),
            Promise.all(auditMonths.map(month =>
              fetch(ESPN_BASE + "/" + slug + "/scoreboard?dates="+month+"&limit=500", { headers: { "Accept": "application/json" } })
            ))
          ]);
          if (!teamResponse.ok) throw new Error("ESPN teams HTTP " + teamResponse.status);
          const failedScoreboard = scoreboardResponses.find(response => !response.ok);
          if (failedScoreboard) throw new Error("ESPN scoreboard HTTP " + failedScoreboard.status);
          const payload = await teamResponse.json();
          const scoreboards = await Promise.all(scoreboardResponses.map(response => response.json()));
          const allScoreboardEvents = scoreboards.flatMap(scoreboard => Array.isArray(scoreboard.events)?scoreboard.events:[]);
          const upcomingEvents = allScoreboardEvents.map(event=>{
            const competitors=event.competitions?.[0]?.competitors||[];
            const home=competitors.find(side=>side.homeAway==="home");
            const away=competitors.find(side=>side.homeAway==="away");
            const status=event.status?.type||event.competitions?.[0]?.status?.type||{};
            const completed=status.completed===true||String(status.state||"").toLowerCase()==="post";
            return { id:String(event.id||""),date:String(event.date||"").slice(0,10),home:String(home?.team?.displayName||home?.team?.name||""),away:String(away?.team?.displayName||away?.team?.name||""),completed };
          }).filter(event=>event.id&&event.date&&event.home&&event.away&&!event.completed&&event.date>=auditStart.toISOString().slice(0,10)&&event.date<=auditEnd.toISOString().slice(0,10));
          const found = [];
          // ESPN's teams endpoint nests actual clubs under sports[].leagues[].teams[].
          // A recursive walk also picked up the sport ("Soccer") and league
          // ("English Premier League") as if they were clubs, inflating the audit.
          const leagueEntries = Array.isArray(payload?.sports)
            ? payload.sports.flatMap(sport => Array.isArray(sport?.leagues) ? sport.leagues : [])
            : [];
          const teamEntries = leagueEntries.flatMap(league => Array.isArray(league?.teams) ? league.teams : []);
          for (const entry of teamEntries) {
            const team = entry?.team && typeof entry.team === "object" ? entry.team : entry;
            if (team && typeof team === "object") found.push(team);
          }
          // Keep a narrow fallback for ESPN response variants, but only inspect
          // explicit team collections; never recursively treat arbitrary id/name
          // objects as clubs.
          if (!found.length && Array.isArray(payload?.teams)) {
            for (const entry of payload.teams) {
              const team = entry?.team && typeof entry.team === "object" ? entry.team : entry;
              if (team && typeof team === "object") found.push(team);
            }
          }
          const unique = new Map();
          for (const team of found) {
            const idValue = String(team.id || "");
            const name = String(team.displayName || team.name || team.shortDisplayName || "").trim();
            if (idValue && name) unique.set(idValue,{ id:idValue,name });
          }
          return { leagueId:id, teams:Array.from(unique.values()), upcomingEvents };
        }));
        const directoriesByLeague = new Map();
        const providerUpcomingByLeague = new Map();
        const directoryErrors = [];
        for (let i=0;i<directoryResults.length;i++) {
          const result = directoryResults[i];
          const leagueId = priorityLeagueDefinitions[i][0];
          if (result.status === "fulfilled") {
            directoriesByLeague.set(leagueId,result.value.teams);
            providerUpcomingByLeague.set(leagueId,result.value.upcomingEvents);
          } else directoryErrors.push({ leagueId,error:String(result.reason?.message || result.reason) });
        }
        const teamCoverageByLeague = new Map();
        for (const row of teamCoverageRows) {
          const leagueId = String(row.leagueId);
          const list = teamCoverageByLeague.get(leagueId) || [];
          list.push(row);
          teamCoverageByLeague.set(leagueId,list);
        }
        const priorityLeagueCoverage = priorityLeagueDefinitions.map(([leagueId,slug]) => {
          const archivedTeams = teamCoverageByLeague.get(leagueId) || [];
          const directory = directoriesByLeague.get(leagueId);
          const archivedByName = new Map(archivedTeams.map(row => [normalizeTeamName(row.teamName),row]));
          const expected = Array.isArray(directory) ? directory : archivedTeams.map(row => ({name:row.teamName}));
          const checkedTeams = expected.map(team => {
            const archived = archivedByName.get(normalizeTeamName(team.name));
            return {
              team:team.name,
              completedMatches:Number(archived?.completedMatches || 0),
              lastMatch:archived?.lastMatch || null,
              ready:Number(archived?.completedMatches || 0) >= 10
            };
          });
          const ready = checkedTeams.filter(team => team.ready).length;
          const providerUpcoming = providerUpcomingByLeague.get(leagueId) || [];
          const providerUpcomingKeys = new Set(providerUpcoming.map(event=>[event.date,auditName(event.home),auditName(event.away)].join("|")));
          const d1UpcomingKeys = d1UpcomingByLeague.get(leagueId) || new Set();
          const missingUpcoming = providerUpcoming.filter(event=>!d1UpcomingKeys.has([event.date,auditName(event.home),auditName(event.away)].join("|")));
          const extraUpcoming = Array.from(d1UpcomingKeys).filter(key=>!providerUpcomingKeys.has(key));
          return {
            leagueId, leagueName:coverageNames[leagueId],
            expectedTeams:directory?.length ?? null,
            observedTeams:archivedTeams.length,
            teamsWithAtLeast10:ready,
            teamsBelow10:checkedTeams.length-ready,
            upcomingMatches:upcomingByLeague.get(leagueId) || 0,
            providerUpcomingMatches:Array.isArray(providerUpcoming)?providerUpcoming.length:null,
            missingUpcomingInD1:missingUpcoming.slice(0,50).map(event=>({date:event.date,home:event.home,away:event.away})),
            d1UpcomingNotInProvider:extraUpcoming.slice(0,50),
            directoryVerified:Array.isArray(directory),
            missingTeams:checkedTeams.filter(team=>!team.ready).slice(0,100),
            archiveTeamsNotInDirectory:archivedTeams.filter(row=>!expected.some(team=>normalizeTeamName(team.name)===normalizeTeamName(row.teamName))).slice(0,50).map(row=>row.teamName)
          };
        });
        const qualityReport = {
          ok: true, scope, days: scope === "upcoming" ? days : null,
          totalRecords, checked: rows.length, limit, truncated: rows.length < totalRecords,
          sourceCounts,
          duplicateGroups: Array.from(duplicateMap.values()).filter(group => group.length > 1).length,
          duplicateRecords: duplicates,
          leagueIdsChecked: leagueMap.size, leagueInconsistencies,
          invalidRecordCount, invalidRecords,
          completedWithoutScoreCount, completedWithoutScore,
          invalidScoreCount,
          eligibleMatchesChecked: validStatistics + missingStatistics,
          matchesWithUsableStatistics: validStatistics,
          missingStatisticsCount: missingStatistics,
          missingStatisticsBySource,
          malformedStatisticsCount,
          malformedStatistics,
          priorityLeagueCoverage,
          priorityLeagueDirectoryErrors: directoryErrors,
          priorityLeagueCoverageNote: "Takım kapsamı ESPN takım rehberiyle karşılaştırılır; rehber alınamayan liglerde yalnızca arşivde gözlenen takımlar sayılır."
        };
        const qualityReportBody = JSON.stringify(qualityReport);
        if (env.MAM_KV) await env.MAM_KV.put(qualityCacheKey, qualityReportBody, { expirationTtl: 6 * 60 * 60 });
        return new Response(qualityReportBody, {
          status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
        });
      }

      if (path === "archive/upcoming" && request.method === "GET") {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: "D1 binding DB is missing" }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const daysValue = Number.parseInt(url.searchParams.get("days") || "30", 10);
        const days = Number.isFinite(daysValue) ? Math.max(1, Math.min(60, daysValue)) : 30;
        const requestedDate = String(url.searchParams.get("date") || "").trim();
        const parsedRequestedDate = Date.parse(requestedDate + "T00:00:00Z");
        const exactDate = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) &&
          Number.isFinite(parsedRequestedDate) &&
          new Date(parsedRequestedDate).toISOString().slice(0, 10) === requestedDate ? requestedDate : "";
        const leagueId = String(url.searchParams.get("league") || "").trim();
        const limitValue = Number.parseInt(url.searchParams.get("limit") || "1000", 10);
        const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(2000, limitValue)) : 1000;
        // Exact calendar-day lookup is a scoreboard query: include scheduled,
        // live and completed fixtures. The rolling upcoming window remains
        // scheduled-only so it does not mix historical results into future lists.
        // Include a UTC-day margin in SQL, then apply the exact Istanbul-day
        // filter below. This handles both Z timestamps and explicit +03:00 offsets
        // without double-shifting already-localized kickoff values.
        const resultsOnly = url.searchParams.get("results") === "1";
        // KV cache prevents repeated identical scoreboard/archive requests from
        // scanning D1. Exact-date results (which may include live matches) use a
        // short TTL; rolling upcoming/results windows use a slightly longer TTL.
        const upcomingCacheKey = "mam:archive-upcoming:v2:" + [exactDate || "window", days, leagueId || "all", limit, resultsOnly ? "results" : "fixtures"].join(":");
        if (env.MAM_KV) {
          try {
            const cachedUpcoming = await env.MAM_KV.get(upcomingCacheKey);
            if (cachedUpcoming) {
              return new Response(cachedUpcoming, {
                status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
              });
            }
          } catch (cacheReadError) {
            console.warn("archive/upcoming KV cache read failed; falling back to D1:", String(cacheReadError?.message || cacheReadError));
          }
        }
        const filters = exactDate
          ? ["date(kickoff) >= date(?, '-1 day')", "date(kickoff) < date(?, '+2 days')"]
          : resultsOnly
            ? ["date(kickoff) >= date('now', '-' || ? || ' days')", "date(kickoff) <= date('now')", "status IN ('FT','AET','PEN','AWD','WO','FINISHED','COMPLETED')", "home_goals IS NOT NULL", "away_goals IS NOT NULL"]
            : ["date(kickoff) >= date('now')", "date(kickoff) <= date('now', '+' || ? || ' days')", "status IN ('NS','TBD','SCHEDULED')"];
        const binds = exactDate ? [exactDate, exactDate] : [days];
        if (leagueId) { filters.push("league_id = ?"); binds.push(leagueId); }
        binds.push(limit);
        const result = await env.DB.prepare(
          "SELECT source, fixture_id, league_id, league_name, country, kickoff, status, home_team_id, home_team, away_team_id, away_team, home_goals, away_goals FROM matches WHERE " +
          filters.join(" AND ") + " ORDER BY datetime(kickoff) " + (resultsOnly ? "DESC" : "ASC") + " LIMIT ?"
        ).bind(...binds).all();
        const sourcePriority = source => {
          const value = String(source || "").toLowerCase();
          return value === "espn" ? 4 : value.includes("football-data") ? 3 : value === "api-football" ? 2 : 1;
        };
        const normalizeTeam = value => String(value || "").normalize("NFD").toLowerCase()
          .replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i")
          .replace(/\b(football club|fc|afc|sk|fk|as|a\.s\.|cf|sc|club|calcio)\b/g, "")
          .replace(/[^a-z0-9]+/g, "").trim();
        const countryForLeague = (leagueId, leagueName, country, source) => canonicalLeagueCountry(source, leagueId, leagueName, country);
        const uniqueRows = new Map();
        const candidateRows = (Array.isArray(result?.results) ? result.results : []).filter(row => {
          if (!exactDate) return true;
          const kickoffText = String(row.kickoff || "");
          const timestamp = Date.parse(kickoffText);
          if (!Number.isFinite(timestamp)) return false;
          const parts = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit"
          }).formatToParts(new Date(timestamp));
          const dateParts = Object.fromEntries(parts.map(part => [part.type, part.value]));
          const istanbulDate = dateParts.year + "-" + dateParts.month + "-" + dateParts.day;
          return istanbulDate === exactDate;
        });
        const dateDebug = [];
        for (const row of candidateRows) {
          const home = normalizeTeam(row.home_team), away = normalizeTeam(row.away_team);
          const time = Date.parse(String(row.kickoff || ""));
          const dateKey = Number.isFinite(time)
            ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(time))
            : String(row.kickoff || "").slice(0, 10);
          const signature = home && away
            ? [row.league_id, dateKey, home, away].join("|")
            : String(row.source) + "|" + String(row.fixture_id);
          const previous = uniqueRows.get(signature);
          if (!previous || sourcePriority(row.source) > sourcePriority(previous.source)) uniqueRows.set(signature, row);
        }
        const deduplicatedRows = Array.from(uniqueRows.values());
        const matches = deduplicatedRows.map(row => ({
          source: row.source || "ESPN",
          fixture: { id: row.fixture_id, date: row.kickoff, status: { short: row.status || "NS" } },
          league: { id: String(row.league_id), name: row.league_name || "", country: countryForLeague(row.league_id, row.league_name, row.country, row.source) },
          teams: {
            home: { id: row.home_team_id == null ? null : row.home_team_id, name: row.home_team || "" },
            away: { id: row.away_team_id == null ? null : row.away_team_id, name: row.away_team || "" }
          },
          goals: { home: row.home_goals, away: row.away_goals }
        }));
        const upcomingResponseBody = JSON.stringify({
          ok: true, days, date: exactDate || null, leagueId: leagueId || null,
          count: matches.length,
          rawCount: Array.isArray(result?.results) ? result.results.length : 0,
          dateMatchedCount: candidateRows.length,
          duplicatesSuppressed: candidateRows.length - deduplicatedRows.length,
          dateDebug,
          response: matches
        });
        if (env.MAM_KV) {
          try {
            await env.MAM_KV.put(upcomingCacheKey, upcomingResponseBody, { expirationTtl: exactDate ? 30 : resultsOnly ? 300 : 300 });
          } catch (cacheWriteError) {
            console.warn("archive/upcoming KV cache write failed:", String(cacheWriteError?.message || cacheWriteError));
          }
        }
        return new Response(upcomingResponseBody, {
          status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
        });
      }

      if (path === "archive/half-goals" && request.method === "GET") {
        if (!env.DB) return new Response(JSON.stringify({ error: "D1 binding DB is missing" }), {
          status: 503, headers: { ...cors, "Content-Type": "application/json" }
        });
        const cacheKey = "mam:half-goals:v1:" + new Date().toISOString().slice(0, 13);
        if (env.MAM_KV) {
          // Cache is an optimization only: a KV read failure must not block
          // the read-only archive response from D1.
          try {
            const cached = await env.MAM_KV.get(cacheKey);
            if (cached) return new Response(cached, {
              status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" }
            });
          } catch (cacheReadError) {
            console.warn("half-goals KV read failed; falling back to D1:", String(cacheReadError?.message || cacheReadError));
          }
        }
        const historyRows = [];
        let historyScanned = 0;
        let upcomingResult;
        try {
          // Use fewer, moderately sized pages: 100-row paging caused too many
          // D1 operations inside the platform's rolling 10-second resource window.
          // 500 rows keeps each response bounded while reducing query count 5x.
          const historyStatement = env.DB.prepare("SELECT source, fixture_id, league_id, league_name, country, kickoff, status, home_team, away_team, home_goals, away_goals, raw_json FROM matches WHERE status IN ('FT','AET','PEN','FINISHED','COMPLETED','AWD','WO') AND home_goals IS NOT NULL AND away_goals IS NOT NULL AND datetime(kickoff) >= datetime('now','-365 days') ORDER BY datetime(kickoff) DESC LIMIT 500 OFFSET ?");
          for (let offset = 0; offset < 6000; offset += 500) {
            const batch = await historyStatement.bind(offset).all();
            const rows = batch?.results || [];
            historyRows.push(...rows);
            historyScanned += rows.length;
            if (rows.length < 500) break;
          }
          upcomingResult = await env.DB.prepare("SELECT source, fixture_id, league_id, league_name, country, kickoff, status, home_team, away_team FROM matches WHERE status IN ('NS','TBD','SCHEDULED') AND datetime(kickoff) >= datetime('now') AND datetime(kickoff) <= datetime('now','+30 days') ORDER BY datetime(kickoff) ASC LIMIT 1500").all();
        } catch (archiveQueryError) {
          const detail = String(archiveQueryError?.message || archiveQueryError).slice(0, 500);
          console.error("half-goals D1 query failed:", detail);
          return new Response(JSON.stringify({
            error: "Half-goals archive database query failed",
            detail
          }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
          });
        }
        const readHalf = value => {
          if (value == null) return null;
          if (typeof value === "number" && Number.isFinite(value)) return value;
          if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
          if (typeof value === "object") {
            const n = value.value ?? value.score ?? value.goals;
            if (n != null && Number.isFinite(Number(n))) return Number(n);
          }
          return null;
        };
        const extractHalf = raw => {
          if (!raw || typeof raw !== "object") return null;
          const score = raw.score || raw.header?.competitions?.[0]?.status?.score || {};
          const direct = score.halftime || score.halfTime || score.half_time || raw.halftime || raw.halfTime || raw.half_time;
          if (direct && typeof direct === "object") {
            const home = readHalf(direct.home ?? direct.homeTeam);
            const away = readHalf(direct.away ?? direct.awayTeam);
            if (home != null && away != null) return { home, away, method: "halftime-score" };
          }
          const competition = raw.competitions?.[0] || raw.header?.competitions?.[0] || raw.event?.competitions?.[0];
          const competitors = Array.isArray(competition?.competitors) ? competition.competitors : [];
          if (competitors.length >= 2) {
            const homeTeam = competitors.find(team => String(team.homeAway || "").toLowerCase() === "home");
            const awayTeam = competitors.find(team => String(team.homeAway || "").toLowerCase() === "away");
            const homeLines = homeTeam?.linescores;
            const awayLines = awayTeam?.linescores;
            if (Array.isArray(homeLines) && Array.isArray(awayLines) && homeLines.length >= 2 && awayLines.length >= 2) {
              const home = readHalf(homeLines[0]);
              const away = readHalf(awayLines[0]);
              if (home != null && away != null) return { home, away, method: "period-linescore" };
            }
          }
          return null;
        };
        const history = [];
        for (const row of historyRows) {
          let raw = null;
          try { raw = row.raw_json ? JSON.parse(row.raw_json) : null; } catch (_) {}
          const halftime = extractHalf(raw);
          if (!halftime) continue;
          const homeGoals = Number(row.home_goals), awayGoals = Number(row.away_goals);
          if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals) ||
              halftime.home < 0 || halftime.away < 0 ||
              halftime.home > homeGoals || halftime.away > awayGoals) continue;
          history.push({
            source: row.source, fixtureId: row.fixture_id, leagueId: String(row.league_id || ""),
            leagueName: row.league_name || "", country: row.country || "", kickoff: row.kickoff,
            home: row.home_team || "", away: row.away_team || "",
            homeGoals, awayGoals, halftimeHome: halftime.home, halftimeAway: halftime.away,
            firstHalfGoal: halftime.home + halftime.away > 0,
            secondHalfGoal: (homeGoals - halftime.home) + (awayGoals - halftime.away) > 0
          });
        }
        const upcoming = (upcomingResult?.results || []).map(row => ({
          source: row.source, fixtureId: row.fixture_id, leagueId: String(row.league_id || ""),
          leagueName: row.league_name || "", country: row.country || "", kickoff: row.kickoff,
          home: row.home_team || "", away: row.away_team || ""
        }));
        const leagues = [...new Map(history.concat(upcoming).map(row => [row.leagueId, {
          id: row.leagueId, name: row.leagueName, country: row.country
        }])).values()].filter(item => item.id).sort((a,b) => a.name.localeCompare(b.name));
        const body = JSON.stringify({
          ok: true, generatedAt: new Date().toISOString(), historyWindowDays: 365,
          historyScanned, historyWithHalfTime: history.length,
          upcomingCount: upcoming.length, leagues, history, upcoming,
          note: "Only fixtures with a verifiable half-time score are included in historical half-goal rates. No half-time score is inferred from full-time score."
        });
        if (env.MAM_KV) {
          // Large archive payloads can exceed KV's per-value limit. Keep the
          // successful D1 response usable even when this optional cache write fails.
          try {
            await env.MAM_KV.put(cacheKey, body, { expirationTtl: 3 * 60 * 60 });
          } catch (cacheWriteError) {
            console.warn("half-goals KV write failed; returning uncached D1 response:", String(cacheWriteError?.message || cacheWriteError));
          }
        }
        return new Response(body, {
          status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" }
        });
      }

      if (path === "archive/matches" && request.method === "GET") {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: "D1 binding DB is missing" }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const leagueId = String(url.searchParams.get("league") || "").trim();
        const before = String(url.searchParams.get("before") || new Date().toISOString()).trim().slice(0, 40);
        const limitValue = Number.parseInt(url.searchParams.get("limit") || "1500", 10);
        const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(2000, limitValue)) : 1500;
        if (!before || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(before)) {
          return new Response(JSON.stringify({ error: "Invalid before date; use YYYY-MM-DD or an ISO timestamp" }), {
            status: 400, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        if (!leagueId) {
          return new Response(JSON.stringify({ error: "A league ID is required" }), {
            status: 400, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const requestedTeamNames = new Set(
          String(url.searchParams.get("teamNames") || "")
            .split(",").map(value => normalizeTeamName(value)).filter(Boolean)
        );
        let archived;
        try {
          // kickoff is stored as an ISO date/time string. A direct range predicate
          // allows idx_matches_league_kickoff to serve this read instead of applying
          // date() to every row in the selected league.
          archived = await env.DB.prepare(`
            SELECT source, fixture_id, league_id, league_name, country, kickoff, status,
                   home_team_id, home_team, away_team, home_goals, away_goals,
                   statistics_json, raw_json
            FROM matches
            WHERE league_id = ?
              AND kickoff < ?
              AND home_goals IS NOT NULL
              AND away_goals IS NOT NULL
            ORDER BY kickoff DESC
            LIMIT ?
          `).bind(leagueId, before, limit).all();
        } catch (archiveReadError) {
          const detail = String(archiveReadError?.message || archiveReadError);
          console.error("D1 archive/matches read failed", {
            leagueId, before, limit, teamFilterCount: requestedTeamNames.size, detail
          });
          return new Response(JSON.stringify({
            error: "D1 archive query failed",
            detail,
            retryable: /busy|overload|temporar|timeout|connection/i.test(detail)
          }), {
            status: 503,
            headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
          });
        }
        const archivedRows = Array.isArray(archived?.results) ? archived.results : [];
        // Apply the requested team filter before shaping the response. Previously the
        // browser sent teamNames but this route ignored them and returned the league's
        // first 2,000 rows, so a team's older fixtures could be pushed out by other clubs.
        const filteredRows = requestedTeamNames.size
          ? archivedRows.filter(row =>
              requestedTeamNames.has(normalizeTeamName(row.home_team)) ||
              requestedTeamNames.has(normalizeTeamName(row.away_team))
            )
          : archivedRows;
        const matches = filteredRows.map(row => {
          let statistics = null;
          let raw = null;
          try { statistics = row.statistics_json ? JSON.parse(row.statistics_json) : null; } catch (_) {}
          try { raw = row.raw_json ? JSON.parse(row.raw_json) : null; } catch (_) {}
          const halftime = raw?.score?.halftime || raw?.score?.halfTime || null;
          return {
            source: row.source || "app",
            fixture: { id: row.fixture_id, date: row.kickoff, status: { short: row.status || "FT" } },
            league: { id: String(row.league_id), name: row.league_name || "", country: canonicalLeagueCountry(row.source, row.league_id, row.league_name, row.country) },
            teams: {
              home: { id: row.home_team_id == null ? null : row.home_team_id, name: row.home_team || "" },
              away: { id: row.away_team_id == null ? null : row.away_team_id, name: row.away_team || "" }
            },
            goals: { home: row.home_goals, away: row.away_goals },
            score: halftime ? { halftime } : null,
            statistics
          };
        });
        return new Response(JSON.stringify({
          ok: true, leagueId, count: matches.length,
          rawCount: archivedRows.length,
          teamFilterApplied: requestedTeamNames.size > 0,
          response: matches
        }), {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, max-age=60" }
        });
      }

      if (path === "archive/matches" && request.method === "POST") {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: "D1 binding DB is missing" }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        let body;
        try { body = await request.json(); }
        catch (_) {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const incoming = Array.isArray(body?.matches) ? body.matches.slice(0, 250) : [];
        if (!incoming.length) {
          return new Response(JSON.stringify({ ok: true, saved: 0, skipped: 0 }), {
            status: 200, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const sql = `INSERT INTO matches
          (source, fixture_id, league_id, league_name, country, kickoff, status,
           home_team_id, home_team, away_team_id, away_team, home_goals, away_goals,
           statistics_json, raw_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source, fixture_id) DO UPDATE SET
           league_id=excluded.league_id, league_name=excluded.league_name,
           country=excluded.country, kickoff=excluded.kickoff, status=excluded.status,
           home_team_id=excluded.home_team_id, home_team=excluded.home_team,
           away_team_id=excluded.away_team_id, away_team=excluded.away_team,
           home_goals=excluded.home_goals, away_goals=excluded.away_goals,
           statistics_json=excluded.statistics_json, raw_json=excluded.raw_json,
           updated_at=CURRENT_TIMESTAMP`;
        const statements = [];
        let skipped = 0;
        for (const m of incoming) {
          const fixture = m?.fixture || {};
          const teams = m?.teams || {};
          const home = teams.home || {};
          const away = teams.away || {};
          const league = m?.league || {};
          const kickoff = String(fixture.date || m?.kickoff || "");
          const homeName = String(home.name || m?.home_team || "").trim();
          const awayName = String(away.name || m?.away_team || "").trim();
          if (!kickoff || !homeName || !awayName) { skipped++; continue; }
          const rawId = fixture.id ?? m?.fixture_id ?? "";
          const fixtureId = String(rawId || (kickoff + "-" + normalizeTeamName(homeName) + "-" + normalizeTeamName(awayName))).slice(0, 120);
          const source = String(m?.mamSource || m?._source || m?.source || "app").slice(0, 60);
          const leagueId = String(league.id ?? body?.leagueId ?? "unknown").slice(0, 40);
          const status = String(fixture.status?.short || m?.status || "UNK").slice(0, 30);
          const homeGoals = m?.goals?.home == null ? null : Number(m.goals.home);
          const awayGoals = m?.goals?.away == null ? null : Number(m.goals.away);
          statements.push(env.DB.prepare(sql).bind(
            source, fixtureId, leagueId,
            String(league.name || m?.league_name || "").slice(0, 120),
            canonicalLeagueCountry(source, leagueId, league.name || m?.league_name, league.country || m?.country).slice(0, 80),
            kickoff.slice(0, 40), status,
            home.id == null ? null : String(home.id).slice(0, 40), homeName.slice(0, 120),
            away.id == null ? null : String(away.id).slice(0, 40), awayName.slice(0, 120),
            Number.isFinite(homeGoals) ? homeGoals : null,
            Number.isFinite(awayGoals) ? awayGoals : null,
            m?.statistics == null ? null : JSON.stringify(m.statistics),
            JSON.stringify(m)
          ));
        }
        let saved = 0;
        for (let i = 0; i < statements.length; i += 50) {
          const results = await env.DB.batch(statements.slice(i, i + 50));
          saved += results.reduce((sum, result) => sum + (Number(result?.meta?.changes) || 0), 0);
        }
        return new Response(JSON.stringify({ ok: true, received: incoming.length, saved, skipped }), {
          status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" }
        });
      }

      if (path === "archive/live" && request.method === "GET") {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: "D1 binding DB is missing" }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const liveCacheKey = "mam:archive-live:v2";
        if (env.MAM_KV) {
          try {
            const cachedLive = await env.MAM_KV.get(liveCacheKey);
            if (cachedLive) {
              return new Response(cachedLive, {
                status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
              });
            }
          } catch (cacheReadError) {
            console.warn("archive/live KV cache read failed; falling back to D1:", String(cacheReadError?.message || cacheReadError));
          }
        }
        const result = await env.DB.prepare(`
          SELECT source, fixture_id, league_id, league_name, country, kickoff, status,
                 home_team_id, home_team, away_team_id, away_team, home_goals, away_goals,
                 statistics_json, raw_json
          FROM matches
          WHERE status IN ('LIVE','1H','2H','HT','ET','BT','P','SUSP','INT','IN_PLAY','PAUSED')
            AND datetime(updated_at) >= datetime('now', '-6 hours')
          ORDER BY datetime(updated_at) DESC
          LIMIT 100
        `).all();
        const matches = (Array.isArray(result?.results) ? result.results : []).map(row => {
          let statistics = null;
          try { statistics = row.statistics_json ? JSON.parse(row.statistics_json) : null; } catch (_) {}
          return {
            source: row.source || "app",
            fixture: { id: row.fixture_id, date: row.kickoff, status: { short: row.status || "LIVE" } },
            league: { id: String(row.league_id), name: row.league_name || "", country: row.country || "" },
            teams: {
              home: { id: row.home_team_id == null ? null : row.home_team_id, name: row.home_team || "" },
              away: { id: row.away_team_id == null ? null : row.away_team_id, name: row.away_team || "" }
            },
            goals: { home: row.home_goals, away: row.away_goals },
            statistics
          };
        });
        const liveResponseBody = JSON.stringify({ ok: true, count: matches.length, response: matches });
        if (env.MAM_KV) {
          try {
            await env.MAM_KV.put(liveCacheKey, liveResponseBody, { expirationTtl: 15 });
          } catch (cacheWriteError) {
            console.warn("archive/live KV cache write failed:", String(cacheWriteError?.message || cacheWriteError));
          }
        }
        return new Response(liveResponseBody, {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
        });
      }

      if (path === "archive/d1-status") {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: "D1 binding DB is missing" }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const d1StatusCacheKey = "mam:d1-status-cache:v2";
        // Status endpoints are expensive aggregate D1 reads. Ignore the legacy
        // fresh=1 bypass and serve the KV snapshot to protect the daily read quota.
        const cachedD1Status = env.MAM_KV ? await env.MAM_KV.get(d1StatusCacheKey) : null;
        if (cachedD1Status) {
          const cachePersisted = env.MAM_KV ? await env.MAM_KV.get("mam:d1-status-cache-persisted:v1") : "1";
          if (env.MAM_KV && !cachePersisted) {
            await env.MAM_KV.put(d1StatusCacheKey, cachedD1Status);
            await env.MAM_KV.put("mam:d1-status-cache-persisted:v1", "1");
          }
          // Keep expensive D1 aggregates cached, but refresh queue/run telemetry
          // from KV on every status request without reading D1.
          try {
            const [liveSummaryQueue, liveSummaryLastRun, liveCrossSourceStats] = await Promise.all([
              env.MAM_KV.get("mam:espn-summary-queue:v1", "json"),
              env.MAM_KV.get("mam:espn-summary-last-run:v1", "json"),
              env.MAM_KV.get("mam:cross-source-stats:last:v4", "json")
            ]);
            const report = JSON.parse(cachedD1Status);
            const queueItems = Array.isArray(liveSummaryQueue) ? liveSummaryQueue : [];
            const now = Date.now();
            const readyToRetry = queueItems.filter(item => !Number(item.retryAfter || 0) || Number(item.retryAfter || 0) <= now);
            const coolingDown = queueItems.length - readyToRetry.length;
            let retryAttempts = {};
            for (const item of queueItems) {
              const attempt = Number(item.attempts || 0);
              retryAttempts[String(attempt)] = (retryAttempts[String(attempt)] || 0) + 1;
            }
            const nextRetryAt = queueItems.reduce((min, item) => {
              const retryAt = Number(item.retryAfter || 0);
              return retryAt > now && (!min || retryAt < min) ? retryAt : min;
            }, 0);
            report.espnSummaryLastRun = liveSummaryLastRun || report.espnSummaryLastRun || null;
            report.crossSourceStatisticsEnrichment = liveCrossSourceStats || report.crossSourceStatisticsEnrichment || null;
            report.pendingSummaryRetries = queueItems.length;
            report.summaryQueueStatus = {
              queued: queueItems.length,
              readyToRetry: readyToRetry.length,
              coolingDown,
              retryAttempts,
              nextRetryAt: nextRetryAt ? new Date(nextRetryAt).toISOString() : null
            };
            report.liveStatusUpdatedAt = new Date().toISOString();
            return new Response(JSON.stringify(report), {
              status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
            });
          } catch (liveStatusError) {
            console.log("Live KV queue status refresh failed; serving cached status", String(liveStatusError?.message || liveStatusError));
            return new Response(cachedD1Status, {
              status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
            });
          }
        }
        // A cache miss must never trigger eight unbounded D1 aggregates from a
        // public status request. Keep the last known snapshot or fail closed.
        return new Response(JSON.stringify({
          ok: false,
          status: "cached-snapshot-unavailable",
          error: "D1 status snapshot is not cached; live aggregate scan was intentionally skipped to protect the daily row-read quota."
        }), {
          status: 503, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
        });
      }
      if (path === "superlig/fixtures") {
        if (!env.MAM_KV) {
          return new Response(JSON.stringify({ error: "MAM_KV KV binding is missing" }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const snapshot = await env.MAM_KV.get("superlig:fixtures:2026-27", "json");
        if (!snapshot || !Array.isArray(snapshot.fixtures)) {
          return new Response(JSON.stringify({ error: "TFF fikstür senkronizasyonu henüz çalışmadı" }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify(snapshot), {
          status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" }
        });
      }

      if (path === "archive/status") {
        if (!env.MAM_KV) {
          return new Response(JSON.stringify({ error: "MAM_KV KV binding is missing" }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const [lastRun, lastError, teamKeys] = await Promise.all([
          env.MAM_KV.get("archive:last-run", "json"),
          env.MAM_KV.get("archive:last-error", "json"),
          env.MAM_KV.list({ prefix: "history:", limit: 1000 })
        ]);
        let archivedMatchesTotal = 0;
        let teamsWithMatches = 0;
        let emptyTeamKeys = 0;
        for (const item of teamKeys.keys) {
          const rows = await env.MAM_KV.get(item.name, "json") || [];
          const count = Array.isArray(rows) ? rows.length : 0;
          archivedMatchesTotal += count;
          if (count > 0) teamsWithMatches++;
          else emptyTeamKeys++;
        }
        return new Response(JSON.stringify({
          ok: Boolean(lastRun) && !lastError,
          lastRun: lastRun || null,
          lastError: lastError || null,
          archivedTeamsListed: teamKeys.keys.length,
          teamsWithMatches,
          emptyTeamKeys,
          archivedMatchesTotal,
          moreTeams: Boolean(teamKeys.list_complete === false)
        }), {
          status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" }
        });
      }

      if (path === "archive/backfill-all" || path === "archive/espn-backfill") {
        return new Response(JSON.stringify({
          error: "KV archive writes are paused to protect the free-tier daily write quota. Read-only archive access remains available."
        }), { status: 410, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
      }

      if (path === "archive/team") {
        if (!env.MAM_KV) {
          return new Response(JSON.stringify({ error: "MAM_KV KV binding is missing" }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const teamName = url.searchParams.get("name") || "";
        const key = normalizeTeamName(teamName);
        if (!key) {
          return new Response(JSON.stringify({ error: "A team name is required" }), {
            status: 400, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const matches = await env.MAM_KV.get("history:" + key, "json") || [];
        return new Response(JSON.stringify({ response: matches, source: "Cloudflare daily archive" }), {
          status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" }
        });
      }

      const isFootballData = path.startsWith("football-data/");
      const apiPath = isFootballStatus
        ? "status"
        : isESPN
        ? path.slice("espn/".length)
        : isSportScore
          ? path.slice("sportscore/".length)
          : isFootballData
          ? path.slice("football-data/".length)
          : isFixtureDownload
            ? path.slice("fixturesdownload/".length)
            : path;

      const apiKey = isESPN || isFixtureDownload || isSportScore
        ? null
        : isFootballData
          ? env.FOOTBALLDATA_API_KEY
          : env.API_FOOTBALL_KEY;

      // ESPN and public FixtureDownload feeds do not require an API key.
      // Only API-Football and football-data.org require their respective secrets.
      if (!isESPN && !isFixtureDownload && !isSportScore && !apiKey) {
        return new Response(JSON.stringify({
          error: isFootballData
            ? "FOOTBALLDATA_API_KEY secret is missing"
            : "API_FOOTBALL_KEY secret is missing"
        }), {
          status: 500,
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }

      // Private, quota-free API-Football account diagnostic. Never return account
      // identity or the API key; bypass shared D1 reservation and edge cache.
      if (isFootballStatus) {
        try {
          const statusResponse = await fetch(API_BASE + "/status", {
            method: "GET",
            headers: { "x-apisports-key": apiKey, "Accept": "application/json" },
            signal: AbortSignal.timeout(12000)
          });
          let statusBody = {};
          try { statusBody = await statusResponse.json(); } catch (_) {}
          const account = statusBody?.response?.account || {};
          const subscription = statusBody?.response?.subscription || {};
          const requests = statusBody?.response?.requests || {};
          return new Response(JSON.stringify({
            diagnostic: "API-Football /status",
            secretConfigured: Boolean(apiKey),
            workerReachedProvider: true,
            providerHttpStatus: statusResponse.status,
            providerOk: statusResponse.ok && (!statusBody.errors || Object.keys(statusBody.errors).length === 0),
            accountPresent: Boolean(account && Object.keys(account).length),
            subscription: {
              plan: subscription.plan || null,
              active: typeof subscription.active === "boolean" ? subscription.active : null,
              end: subscription.end || null
            },
            requests: {
              current: Number.isFinite(Number(requests.current)) ? Number(requests.current) : null,
              dailyLimit: Number.isFinite(Number(requests.limit_day)) ? Number(requests.limit_day) : null
            },
            errors: statusBody.errors || {},
            checkedAt: new Date().toISOString()
          }), {
            status: statusResponse.ok ? 200 : statusResponse.status,
            headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
          });
        } catch (diagnosticError) {
          return new Response(JSON.stringify({
            diagnostic: "API-Football /status",
            secretConfigured: Boolean(apiKey),
            workerReachedProvider: false,
            providerOk: false,
            error: String(diagnosticError?.message || diagnosticError),
            checkedAt: new Date().toISOString()
          }), {
            status: 502,
            headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
          });
        }
      }

      const isESPNStandings = isESPN && apiPath.endsWith("/standings");
      const base = isFixtureDownload ? "https://fixturedownload.com/feed/json" : isSportScore ? "https://sportscore.com/api" : isESPNStandings ? "https://site.api.espn.com/apis/v2/sports/soccer" : isESPN ? ESPN_BASE : isFootballData ? FOOTBALLDATA_BASE : API_BASE;
      const targetUrl = base + "/" + apiPath + (isSportScore ? "/" : "") + url.search;
      const isStandings = /(^|\/)standings$/.test(apiPath);
      const footballDataStatuses = (url.searchParams.get("status") || "").split(",").map(value => value.trim().toUpperCase());
      const todayIstanbul = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date()).replace(/-/g, "");
      const yesterdayIstanbul = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit"
      }).format(new Date(Date.now() - 24 * 60 * 60 * 1000)).replace(/-/g, "");
      const espnScoreboardDate = url.searchParams.get("dates") || "";
      const isEspnLiveScoreboard = isESPN && apiPath === "scoreboard" &&
        (espnScoreboardDate === todayIstanbul || espnScoreboardDate === yesterdayIstanbul);
      // ESPN scoreboard and summary requests used by the live screen must not
      // inherit the generic 15-minute ESPN cache. Keep them on the 20-second
      // live cache so scores, goals and match clocks can advance together.
      const isEspnLiveSummary = isESPN && apiPath === "summary" && /^\d+$/.test(url.searchParams.get("event") || "");
      const isSportScoreLive = isSportScore && /^(?:widget\/matches|v1\/fixtures|widget\/match)$/.test(apiPath);
      const isLive = isSportScoreLive || url.searchParams.get("live") === "all" ||
        (isFootballData && apiPath === "matches" && footballDataStatuses.some(value => ["LIVE", "IN_PLAY", "PAUSED"].includes(value))) ||
        isEspnLiveScoreboard || isEspnLiveSummary;
      const isLiveStats = apiPath === "fixtures/statistics" || (isESPN && apiPath === "summary");
      const isLineupData = apiPath === "fixtures/lineups" || apiPath === "fixtures/players";
      const cacheUrl = new URL(url.toString());
      // Yeni anahtar, önceki 12 saatlik puan tablosu kayıtlarını devre dışı bırakır.
      if (isStandings) cacheUrl.searchParams.set("__mam_cache", "standings-v2");
      if (isLive) cacheUrl.searchParams.set("__mam_cache", "live-v1");
      if (isLiveStats) cacheUrl.searchParams.set("__mam_cache", "live-stats-v1");
      if (isLineupData) cacheUrl.searchParams.set("__mam_cache", "lineups-v1");
      const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

      let cache = null;

      try {
        cache = caches.default;
        const cached = await cache.match(cacheKey);

        if (cached) {
          const headers = new Headers(cached.headers);
          Object.entries(cors).forEach(([key, value]) => {
            headers.set(key, value);
          });

          return new Response(cached.body, {
            status: cached.status,
            statusText: cached.statusText,
            headers
          });
        }
      } catch (cacheError) {
        cache = null;
      }

      // Shared server-side guard: protect the single API-Football key across
      // every visitor/device. Cache hits return above and do not consume quota.
      const isPrimaryFootballApi = !isFootballStatus && !isESPN && !isFixtureDownload && !isSportScore && !isFootballData;
      if (isPrimaryFootballApi) {
        if (!env.DB) {
          return new Response(JSON.stringify({
            error: "API-Football upstream blocked: D1 quota guard is unavailable"
          }), {
            status: 503,
            headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
          });
        }
        const utcDay = new Date().toISOString().slice(0, 10);
        // Keep the shared D1 guard aligned with the provider plan. Default stays
        // conservative for Free; after upgrading, set API_FOOTBALL_DAILY_LIMIT
        // in Worker variables (e.g. 6500 for a 7,500/day Pro plan).
        const configuredLimit = Number(env.API_FOOTBALL_DAILY_LIMIT || 85);
        const dailyLimit = Number.isFinite(configuredLimit)
          ? Math.max(1, Math.floor(configuredLimit))
          : 85;
        // Quota-guard schema is maintained by the scheduled migration, not per request.
        await env.DB.prepare(
          "INSERT OR IGNORE INTO mam_api_quota_guard (day, used, live_last_ms) VALUES (?, 0, 0)"
        ).bind(utcDay).run();
        // Free-plan protection: reserve most API-Football calls for fixtures and
        // analysis. Live API-Football is only a fallback; ESPN remains the fast
        // live feed. A 5-minute shared lock prevents every browser refresh from
        // consuming the 85-call daily safety budget.
        const nowMs = Date.now();
        const livePollIntervalMs = 5 * 60 * 1000;
        const minimumRequestSpacingMs = 8000; // Stay below the provider 10-requests/minute ceiling with headroom.
        const reservation = await env.DB.prepare(
          "UPDATE mam_api_quota_guard SET used = used + 1, live_last_ms = CASE WHEN ? = 1 THEN ? ELSE live_last_ms END, minute_last_ms = ? WHERE day = ? AND used < ? AND minute_last_ms <= ? AND (? = 0 OR live_last_ms = 0 OR live_last_ms <= ?) RETURNING used, live_last_ms, minute_last_ms"
        ).bind(isLive ? 1 : 0, nowMs, nowMs + minimumRequestSpacingMs, utcDay, dailyLimit, nowMs, isLive ? 1 : 0, nowMs - livePollIntervalMs).first();
        if (!reservation) {
          const state = await env.DB.prepare(
            "SELECT used, live_last_ms, minute_last_ms FROM mam_api_quota_guard WHERE day = ?"
          ).bind(utcDay).first();
          const liveWait = isLive && Number(state?.live_last_ms || 0) > nowMs - livePollIntervalMs;
          const minuteWait = Number(state?.minute_last_ms || 0) > nowMs;
          const dailyWait = Number(state?.used || 0) >= dailyLimit;
          const retryAt = liveWait
            ? Number(state.live_last_ms) + livePollIntervalMs
            : minuteWait
              ? Number(state.minute_last_ms)
              : Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1);
          const retrySeconds = Math.max(1, Math.ceil((retryAt - nowMs) / 1000));
          return new Response(JSON.stringify({
            error: liveWait
              ? "API-Football live fallback is shared and limited to one upstream request every 5 minutes on the Free plan."
              : dailyWait
                ? "API-Football shared daily safety budget reached."
                : "API-Football shared per-minute limit reached; retry after the indicated delay.",
            used: Number(state?.used || 0),
            limit: dailyLimit,
            retryAfterSeconds: retrySeconds
          }), {
            status: 429,
            headers: {
              ...cors,
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "no-store",
              "Retry-After": String(retrySeconds)
            }
          });
        }
        // One request may wait behind the previous device; all others receive Retry-After.
        // Reservation advances the shared slot; the first request may proceed immediately.
        const waitMs = 0;
      }

      const upstreamHeaders = (isESPN || isFixtureDownload || isSportScore)
        ? { "Accept": "application/json" }
        : isFootballData
          ? { "X-Auth-Token": apiKey }
          : { "x-apisports-key": apiKey };

      // Bound provider latency so a stalled upstream cannot hold the Worker request open.
      // No automatic retry here: retries could consume extra API-Football quota unexpectedly.
      const upstream = await fetch(targetUrl, {
        method: "GET",
        headers: upstreamHeaders,
        signal: AbortSignal.timeout(12000)
      });

      // Persist provider-side 429 cooldown centrally so every device stops
      // consuming the same API key while the subscription limit recovers.
      if (isPrimaryFootballApi && upstream.status === 429 && env.DB) {
        const retryHeader = Number.parseInt(upstream.headers.get("retry-after") || "", 10);
        const cooldownSeconds = Number.isFinite(retryHeader) && retryHeader > 0
          ? Math.min(15 * 60, Math.max(60, retryHeader))
          : 60;
        const cooldownUntil = Date.now() + cooldownSeconds * 1000;
        await env.DB.prepare(
          "UPDATE mam_api_quota_guard SET minute_last_ms = MAX(minute_last_ms, ?) WHERE day = ?"
        ).bind(cooldownUntil, new Date().toISOString().slice(0, 10)).run();
      }

      const responseHeaders = new Headers(cors);
      responseHeaders.set(
        "Content-Type",
        upstream.headers.get("Content-Type") || "application/json; charset=utf-8"
      );
      // Expose provider quota headers to the browser app so it can distinguish
      // daily exhaustion from a short per-minute 429 and stop wasteful retries.
      for (const headerName of [
        "x-ratelimit-requests-limit",
        "x-ratelimit-requests-remaining",
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "retry-after"
      ]) {
        const headerValue = upstream.headers.get(headerName);
        if (headerValue) responseHeaders.set(headerName, headerValue);
      }
      responseHeaders.set(
        "Access-Control-Expose-Headers",
        "x-ratelimit-requests-limit, x-ratelimit-requests-remaining, x-ratelimit-limit, x-ratelimit-remaining, retry-after"
      );

      const response = new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders
      });

      if (upstream.ok && cache) {
        const cacheHeaders = new Headers(response.headers);
        // Shared edge cache reduces duplicate ESPN scoreboard calls across all
        // visitors while keeping live scoreboards fresh within 20 seconds.
        // A single-match live summary stays at 5 seconds for clock/stat detail.
        // Date-scoped fixture lists change more often than historical team data.
        // Keep today's/upcoming fixture responses short-lived so postponed or
        // newly published matches appear promptly without turning off edge caching.
        const isFixtureList = apiPath === "fixtures";
        const responseCacheSeconds = isEspnLiveSummary ? 5
          : isEspnLiveScoreboard ? 20
          : isSportScore ? 8
          : isLive ? 5
          : isLineupData ? 300
          : isESPN && apiPath === "summary" ? 300
          : isLiveStats ? 15
          : isESPN ? 900
          : isStandings ? STANDINGS_CACHE_SECONDS
          : isFixtureList && url.searchParams.has("date") ? 300
          : isFixtureList ? 900
          : CACHE_SECONDS;
        cacheHeaders.set("Cache-Control", "public, max-age=" + responseCacheSeconds);

        const cacheCopy = new Response(response.clone().body, {
          status: response.status,
          statusText: response.statusText,
          headers: cacheHeaders
        });

        try {
          await cache.put(cacheKey, cacheCopy);
        } catch (cacheError) {
          // Cache failure must not block the API response.
        }
      }

      return response;
    } catch (error) {
      return new Response(JSON.stringify({
        error: "Worker request failed",
        detail: String(error && error.message ? error.message : error)
      }), {
        status: 502,
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }
  }
};
