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


function normalizeTeamName(value) {
  return String(value || "").normalize("NFD").toLowerCase()
    .replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
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
  const [sourceRows, missingRows] = await Promise.all([
    env.DB.prepare("SELECT fixture_id, kickoff, home_team, away_team, statistics_json FROM matches WHERE source = 'ESPN' AND statistics_json IS NOT NULL AND statistics_json != '' ORDER BY kickoff DESC LIMIT 2000").all(),
    env.DB.prepare("SELECT source, fixture_id, kickoff, home_team, away_team FROM matches WHERE source != 'ESPN' AND (statistics_json IS NULL OR statistics_json = '' OR statistics_json = 'null') ORDER BY kickoff DESC LIMIT 3000").all()
  ]);
  const source = Array.isArray(sourceRows?.results) ? sourceRows.results : [];
  const missing = Array.isArray(missingRows?.results) ? missingRows.results : [];
  const index = new Map();
  let usableEspnStats = 0;
  for (const row of source) {
    if (!hasUsableStatistics(row.statistics_json)) continue;
    usableEspnStats++;
    const key = normalizeTeamName(row.home_team) + "|" + normalizeTeamName(row.away_team);
    if (!key || key === "|") continue;
    const time = Date.parse(row.kickoff || "");
    if (!Number.isFinite(time)) continue;
    const list = index.get(key) || [];
    list.push({ fixtureId: row.fixture_id, time, statistics: row.statistics_json });
    index.set(key, list);
  }
  const updates = [];
  let exactTeamMatches = 0;
  let withinTimeWindow = 0;
  for (const row of missing) {
    const key = normalizeTeamName(row.home_team) + "|" + normalizeTeamName(row.away_team);
    const time = Date.parse(row.kickoff || "");
    if (!Number.isFinite(time)) continue;
    const candidates = index.get(key) || [];
    if (candidates.length) exactTeamMatches++;
    let best = null, bestDelta = Infinity;
    for (const candidate of candidates) {
      const delta = Math.abs(candidate.time - time);
      if (delta <= 10 * 60 * 1000 && delta < bestDelta) { best = candidate; bestDelta = delta; }
    }
    if (best) {
      withinTimeWindow++;
      updates.push(env.DB.prepare(
        "UPDATE matches SET statistics_json = ?, updated_at = CURRENT_TIMESTAMP WHERE source = ? AND fixture_id = ? AND (statistics_json IS NULL OR statistics_json = '' OR statistics_json = 'null')"
      ).bind(best.statistics, row.source, row.fixture_id));
    }
  }
  let updated = 0;
  for (let i = 0; i < updates.length; i += 50) {
    const results = await env.DB.batch(updates.slice(i, i + 50));
    updated += results.reduce((sum, item) => sum + (Number(item?.meta?.changes) || 0), 0);
  }
  const report = {
    ranAt: new Date().toISOString(),
    espnRowsScanned: source.length,
    usableEspnStats,
    nonEspnMissingRowsScanned: missing.length,
    exactTeamMatches,
    withinTenMinuteWindow: withinTimeWindow,
    updateAttempts: updates.length,
    updated
  };
  if (env.MAM_KV) await env.MAM_KV.put("mam:cross-source-stats:last:v1", JSON.stringify(report), { expirationTtl: 60 * 60 * 24 * 30 });
  console.log("Cross-source statistics enrichment report", report);
  return report;
}

// Safe, additive D1 indexes: they speed up league/date archive reads and status checks.
// CREATE INDEX IF NOT EXISTS leaves every existing match row untouched.
async function ensureArchiveIndexes(env) {
  if (!env.DB) return;
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_matches_league_kickoff ON matches (league_id, kickoff)"
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_matches_status_kickoff ON matches (status, kickoff)"
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_matches_updated_at ON matches (updated_at)"
  ).run();
}

// KV archive writes are intentionally disabled on the free tier.
// Historical matches are served read-only from existing KV data and the app's CSV/ESPN fallbacks.


async function syncEspnFixturesToD1(env, lookBackDays = 45, lookAheadDays = 14, maxRequests = 40) {
  if (!env.DB || !env.MAM_KV) return { saved: 0, failed: 0, complete: false, reason: "DB or MAM_KV binding missing" };
  // ESPN scoreboard coverage mirrors the app's supported ESPN fallback competitions.
  // Keep league IDs aligned with the app so every archived row is queryable by league.
  const leagues = [
    ["39","eng.1","Premier League","England"],
    ["40","eng.2","Championship","England"],
    ["45","eng.fa","FA Cup","England"],
    ["48","eng.league_cup","EFL Cup","England"],
    ["140","esp.1","La Liga","Spain"],
    ["141","esp.2","La Liga 2","Spain"],
    ["143","esp.copa_del_rey","Copa del Rey","Spain"],
    ["78","ger.1","Bundesliga","Germany"],
    ["79","ger.2","2. Bundesliga","Germany"],
    ["81","ger.dfb_pokal","DFB Pokal","Germany"],
    ["135","ita.1","Serie A","Italy"],
    ["136","ita.2","Serie B","Italy"],
    ["137","ita.coppa_italia","Coppa Italia","Italy"],
    ["61","fra.1","Ligue 1","France"],
    ["62","fra.2","Ligue 2","France"],
    ["66","fra.coupe_de_france","Coupe de France","France"],
    ["2","uefa.champions","UEFA Champions League","Europe"],
    ["3","uefa.europa","UEFA Europa League","Europe"],
    ["848","uefa.europa.conf","UEFA Conference League","Europe"],
    ["94","por.1","Primeira Liga","Portugal"],
    ["88","ned.1","Eredivisie","Netherlands"],
    ["144","bel.1","Belgian Pro League","Belgium"],
    ["203","tur.1","Süper Lig","Türkiye"],
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
  if (!state || !Array.isArray(state.jobs) || !Number.isInteger(state.cursor) || state.cursor >= state.jobs.length) {
    const dates = [];
    const base = new Date();
    base.setUTCHours(12, 0, 0, 0);
    for (let offset = -Math.max(1, lookBackDays); offset <= lookAheadDays; offset++) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + offset);
      dates.push(d.toISOString().slice(0, 10).replace(/-/g, ""));
    }
    const jobs = [];
    for (const league of leagues) for (const date of dates) jobs.push({ league, date, attempts: 0 });
    state = { version: 1, jobs, cursor: 0, createdAt: new Date().toISOString() };
  }

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
  if (summaryQueue.length < 480) {
    // D1 has a bounded bind-parameter budget. Do not generate one SQL placeholder
    // per queued fixture (a 458-item queue can make the query fail before summaries run).
    // Read a bounded candidate window and exclude queued IDs in JavaScript instead.
    const queuedFixtureIds = new Set(summaryQueue.map(item => String(item.fixtureId || "")).filter(Boolean));
    const missingRows = await env.DB.prepare(
      "SELECT fixture_id AS fixtureId FROM matches WHERE source = 'ESPN' AND status IN ('FT','AET','PEN','LIVE','1H','2H','HT','ET','P','INT') AND (" +
      "statistics_json IS NULL OR statistics_json = '' OR statistics_json = 'null' OR json_valid(statistics_json) = 0 OR (" +
      "CASE WHEN json_valid(statistics_json) = 1 THEN COALESCE(json_array_length(json_extract(statistics_json, '$.teams[0].statistics')), 0) ELSE 0 END = 0 AND " +
      "CASE WHEN json_valid(statistics_json) = 1 THEN COALESCE(json_array_length(json_extract(statistics_json, '$.teams[1].statistics')), 0) ELSE 0 END = 0))" +
      " ORDER BY kickoff ASC LIMIT 2500"
    ).all();
    for (const row of (Array.isArray(missingRows?.results) ? missingRows.results : [])) {
      if (summaryQueue.length >= 480) break;
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
  }

  // When the statistics backlog is large (for example, hundreds of missing ESPN
  // box scores), shift the safe 48-request budget toward summaries: 24 scoreboard
  // + 24 summary calls. With a small queue retain 32 scoreboard + 16 summaries.
  const summaryBatchLimit = summaryQueue.length >= 100 ? 24 : 16;
  const scoreboardBatchLimit = Math.min(maxRequests, 48 - summaryBatchLimit);
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
        if (status === "LIVE" || status === "FT") {
          const key = "ESPN:" + fixtureId;
          if (!summaryDoneSet.has(key) && !summaryQueue.some(item => item.key === key)) {
            summaryQueue.push({ key, slug, fixtureId, eventId: String(event.id), attempts: 0 });
          }
        }
      }
    } catch (error) {
      failed++;
      const attempts = Number(job.attempts || 0);
      if (attempts < 2) retryJobs.push({ ...job, attempts: attempts + 1 });
      console.log("ESPN archive sync failed", slug, job.date, String(error?.message || error), "attempt", attempts + 1);
    }
  };

  // Small concurrent groups keep the invocation comfortably below the Workers subrequest ceiling.
  for (let i = 0; i < batch.length; i += 4) {
    await Promise.all(batch.slice(i, i + 4).map(fetchJob));
  }

  const sql = "INSERT INTO matches (source, fixture_id, league_id, league_name, country, kickoff, status, home_team_id, home_team, away_team_id, away_team, home_goals, away_goals, statistics_json, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, fixture_id) DO UPDATE SET league_id=excluded.league_id, league_name=excluded.league_name, country=excluded.country, kickoff=excluded.kickoff, status=excluded.status, home_team_id=excluded.home_team_id, home_team=excluded.home_team, away_team_id=excluded.away_team_id, away_team=excluded.away_team, home_goals=excluded.home_goals, away_goals=excluded.away_goals, raw_json=excluded.raw_json, updated_at=CURRENT_TIMESTAMP";
  let saved = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const statements = rows.slice(i, i + 50).map(m => env.DB.prepare(sql).bind(
      m.source, m.fixtureId, m.leagueId, m.leagueName, m.country, m.kickoff, m.status,
      m.homeId, m.homeName, m.awayId, m.awayName, m.homeGoals, m.awayGoals, null, m.raw
    ));
    const result = await env.DB.batch(statements);
    saved += result.reduce((sum, item) => sum + (Number(item?.meta?.changes) || 0), 0);
  }

  // Fetch detailed box-score statistics for live and completed matches in small batches.
  // Scoreboard sync remains the source of truth for status and goals; summaries enrich statistics_json.
  const nowMs = Date.now();
  const readySummaries = [];
  const deferredSummaries = [];
  for (const item of summaryQueue) {
    if (Number(item.retryAfter || 0) <= nowMs && readySummaries.length < summaryBatchLimit) readySummaries.push(item);
    else deferredSummaries.push(item);
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
    saved: 0
  };
  for (let i = 0; i < summaryBatch.length; i += 4) {
    await Promise.all(summaryBatch.slice(i, i + 4).map(async item => {
      try {
        const response = await fetch(ESPN_BASE + "/" + item.slug + "/summary?event=" + encodeURIComponent(item.eventId), {
          headers: { "Accept": "application/json" }
        });
        if (!response.ok) throw new Error("ESPN summary HTTP " + response.status);
        const payload = await response.json();
        const teams = Array.isArray(payload?.boxscore?.teams) ? payload.boxscore.teams : [];
        const statistics = teams.map(team => ({
          homeAway: team.homeAway || null,
          team: team.team?.displayName || team.team?.name || null,
          statistics: Array.isArray(team.statistics) ? team.statistics : []
        }));
        const hasActualStatistics = statistics.some(team => team.statistics.length > 0);
        if (hasActualStatistics) {
          await env.DB.prepare(
            "UPDATE matches SET statistics_json = ?, updated_at = CURRENT_TIMESTAMP WHERE source = 'ESPN' AND fixture_id = ?"
          ).bind(JSON.stringify({ teams: statistics, summaryAvailable: true }), item.fixtureId).run();
          summaryDoneSet.add(item.key);
          summaryRun.fetchedWithStatistics++;
          summaryRun.saved++;
        } else if (Number(item.attempts || 0) < 1) {
          summaryRun.noStatisticsReturned++;
          summaryRetries.push({ ...item, attempts: Number(item.attempts || 0) + 1, retryAfter: Date.now() + 15 * 60 * 1000 });
        } else {
          summaryRun.noStatisticsReturned++;
          // Do not permanently mark a match complete when ESPN has not supplied statistics.
          // Cool down this item and retry it in a later scheduled run.
          summaryRetries.push({ ...item, attempts: 0, retryAfter: Date.now() + 6 * 60 * 60 * 1000 });
        }
      } catch (error) {
        summaryRun.requestFailures++;
        if (Number(item.attempts || 0) < 1) summaryRetries.push({ ...item, attempts: Number(item.attempts || 0) + 1, retryAfter: Date.now() + 15 * 60 * 1000 });
        else summaryRetries.push({ ...item, attempts: 0, retryAfter: Date.now() + 6 * 60 * 60 * 1000 });
        console.log("ESPN match statistics sync failed", item.fixtureId, String(error?.message || error));
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
  if (complete) {
    await env.MAM_KV.delete(stateKey);
  } else {
    await env.MAM_KV.put(stateKey, JSON.stringify(state));
  }
  console.log("ESPN D1 archive sync batch", {
    saved, failed, processed: batch.length, totalJobs: state.jobs.length,
    nextCursor: complete ? null : state.cursor, complete, retryQueued: retryJobs.length,
    summariesProcessed: summaryBatch.length, summariesPending: summaryQueue.length
  });
  if (complete) console.log("ESPN D1 archive sync complete", { saved, failed, leagues: leagues.length });
  return { saved, failed, complete, processed: batch.length, nextCursor: complete ? null : state.cursor };
}

export default {
  // Daily TFF fixture sync: one KV write per run, keeping free-tier writes low.
  async scheduled(event, env, ctx) {
    const isDailySync = event?.cron === '0 3 * * *';
    const isHourlySync = !isDailySync;
    if (env.DB) {
      try {
        // Additive indexes improve archive queries without modifying or deleting stored matches.
        await ensureArchiveIndexes(env);
        // Normalize known competition regions in-place; metadata only, no match rows are removed.
        const normalizedLeagueRows = await normalizeKnownLeagueCountries(env);
        if (normalizedLeagueRows) console.log("Normalized league country metadata", { rows: normalizedLeagueRows });
        // Keep a rolling 45-day history plus 30 days of upcoming fixtures across configured ESPN competitions.
        // Each invocation also fetches up to 16 ESPN match summaries.
        // Keep scoreboard (32) + summary (16) fetches at 48 total, below the 50-subrequest
        // Workers Free limit while increasing archive throughput by one third.
        await syncEspnFixturesToD1(env, 45, 30, isHourlySync ? 32 : 10);
      } catch (archiveError) {
        console.log('ESPN D1 archive sync error', String(archiveError?.message || archiveError));
      }
      // Run cross-provider enrichment independently of ESPN backfill success.
      // This guarantees a diagnostic report on every scheduled invocation.
      try {
        const crossSourceStats = await enrichExactCrossSourceMatches(env);
        console.log("Scheduled cross-source statistics enrichment", crossSourceStats);
      } catch (enrichmentError) {
        const report = { ranAt: new Date().toISOString(), error: String(enrichmentError?.message || enrichmentError) };
        if (env.MAM_KV) await env.MAM_KV.put("mam:cross-source-stats:last:v1", JSON.stringify(report), { expirationTtl: 60 * 60 * 24 * 30 });
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
      } catch (d1Error) {
        // D1 geçici hata verse bile mevcut TFF KV fikstür servisi çalışmaya devam etsin.
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

      const path = url.pathname.replace(/^\/api\//, "");

      const isESPN = path.startsWith("espn/");
      const isFixtureDownload = path.startsWith("fixturesdownload/");
      const validESPNPath = /^espn\/[a-zA-Z0-9._-]+\/(?:scoreboard|summary|standings|teams|teams\/[0-9]+\/schedule)$/.test(path) && ( !path.endsWith("/summary") || /^\d+$/.test(url.searchParams.get("event") || "") );
      const validFixtureDownloadPath = /^fixturesdownload\/(?:champions-league|europa-league|conference-league)-20(?:24|25|26|27)$/.test(path);
      const validStandardPath = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path);

      if (!(isESPN ? validESPNPath : isFixtureDownload ? validFixtureDownloadPath : validStandardPath)) {
        return new Response("Invalid API path", {
          status: 400,
          headers: cors
        });
      }

      // Read-only match archive and aggregate diagnostics are public.
      // Writes and all other private routes still require a signed-in session.
      const publicArchiveRead = request.method === "GET" &&
        (path === "archive/d1-status" || path === "archive/sync-status" || path === "archive/matches" || path === "archive/upcoming" || path === "archive/quality-check" || path === "archive/live" ||
         (isESPN && path.endsWith("/summary") && /^\d+$/.test(url.searchParams.get("event") || "")));
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
        const [state, queueValue, lastSummaryRun, missingStatsResult] = await Promise.all([
          env.MAM_KV.get("mam:espn-sync-state:v2", "json"),
          env.MAM_KV.get("mam:espn-summary-queue:v1", "json"),
          env.MAM_KV.get("mam:espn-summary-last-run:v1", "json"),
          env.DB ? env.DB.prepare("SELECT COUNT(*) AS total FROM matches WHERE source = 'ESPN' AND status IN ('FT','AET','PEN','LIVE','1H','2H','HT','ET','P','INT') AND (statistics_json IS NULL OR statistics_json = '' OR statistics_json = 'null' OR json_valid(statistics_json) = 0 OR (CASE WHEN json_valid(statistics_json) = 1 THEN COALESCE(json_array_length(json_extract(statistics_json, '$.teams[0].statistics')), 0) ELSE 0 END = 0 AND CASE WHEN json_valid(statistics_json) = 1 THEN COALESCE(json_array_length(json_extract(statistics_json, '$.teams[1].statistics')), 0) ELSE 0 END = 0))").first() : Promise.resolve(null)
        ]);
        const jobs = Array.isArray(state?.jobs) ? state.jobs.length : 0;
        const cursor = Number(state?.cursor || 0);
        const scoreboardActive = jobs > 0 && cursor < jobs;
        const queue = Array.isArray(queueValue) ? queueValue : [];
        const now = Date.now();
        const readyToRetry = queue.filter(item => Number(item?.retryAfter || 0) <= now).length;
        const coolingDown = queue.length - readyToRetry;
        const missingStatisticsInD1 = Number(missingStatsResult?.total || 0);
        const active = scoreboardActive || queue.length > 0 || missingStatisticsInD1 > 0;
        return new Response(JSON.stringify({
          ok: true,
          active,
          complete: !active,
          createdAt: state?.createdAt || null,
          totalJobs: jobs,
          processedJobs: Math.min(cursor, jobs),
          remainingJobs: Math.max(0, jobs - cursor),
          progressPercent: jobs ? Math.round(Math.min(cursor, jobs) / jobs * 1000) / 10 : (scoreboardActive ? 0 : 100),
          scoreboardActive,
          scoreboardComplete: !scoreboardActive,
          statisticsQueuePending: queue.length,
          missingStatisticsInD1,
          statisticsReadyToRetry: readyToRetry,
          statisticsCoolingDown: coolingDown,
          lastSummaryRun: lastSummaryRun || null,
          note: scoreboardActive
            ? "ESPN fixture archive scan is in progress"
            : queue.length || missingStatisticsInD1 > 0
              ? "Fixture scan is complete or between batches; missing statistics remain in the archive and are being retried"
              : "Fixture scan and statistics retry queue are clear"
        }), {
          status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
        });
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
        const limitValue = Number.parseInt(url.searchParams.get("limit") || "10000", 10);
        const limit = Number.isFinite(limitValue) ? Math.max(100, Math.min(20000, limitValue)) : 10000;
        const daysValue = Number.parseInt(url.searchParams.get("days") || "30", 10);
        const days = Number.isFinite(daysValue) ? Math.max(1, Math.min(60, daysValue)) : 30;
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
            if (invalidRecords.length < 100) invalidRecords.push({ source, fixtureId: row.fixture_id, leagueId, leagueName, kickoff, home: row.home_team, away: row.away_team });
          }
          if (["FT", "AET", "PEN"].includes(status) && (row.home_goals == null || row.away_goals == null)) {
            if (completedWithoutScore.length < 100) completedWithoutScore.push({ source, fixtureId: row.fixture_id, leagueId, kickoff, home: row.home_team, away: row.away_team, homeGoals: row.home_goals, awayGoals: row.away_goals });
          }
          if ((row.home_goals != null && (!Number.isFinite(Number(row.home_goals)) || Number(row.home_goals) < 0 || Number(row.home_goals) > 30)) ||
              (row.away_goals != null && (!Number.isFinite(Number(row.away_goals)) || Number(row.away_goals) < 0 || Number(row.away_goals) > 30))) invalidScoreCount++;
          const eligible = ["FT", "AET", "PEN", "LIVE", "1H", "2H", "HT", "ET", "P", "INT"].includes(status);
          if (eligible) {
            let usable = false;
            if (row.statistics_json && row.statistics_json !== "null") {
              try {
                const parsed = JSON.parse(row.statistics_json);
                usable = hasUsableStatistics(parsed);
              } catch (_) {
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
        return new Response(JSON.stringify({
          ok: true, scope, days: scope === "upcoming" ? days : null,
          totalRecords, checked: rows.length, limit, truncated: rows.length < totalRecords,
          sourceCounts,
          duplicateGroups: duplicates.length, duplicateRecords: duplicates,
          leagueIdsChecked: leagueMap.size, leagueInconsistencies,
          invalidRecordCount: invalidRecords.length, invalidRecords,
          completedWithoutScoreCount: completedWithoutScore.length, completedWithoutScore,
          invalidScoreCount,
          eligibleMatchesChecked: validStatistics + missingStatistics,
          matchesWithUsableStatistics: validStatistics,
          missingStatisticsCount: missingStatistics,
          missingStatisticsBySource,
          malformedStatisticsCount: malformedStatistics.length,
          malformedStatistics
        }), {
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
        const leagueId = String(url.searchParams.get("league") || "").trim();
        const limitValue = Number.parseInt(url.searchParams.get("limit") || "1000", 10);
        const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(2000, limitValue)) : 1000;
        const filters = ["date(kickoff) >= date('now')", "date(kickoff) <= date('now', '+' || ? || ' days')", "status IN ('NS','TBD','SCHEDULED')"];
        const binds = [days];
        if (leagueId) { filters.push("league_id = ?"); binds.push(leagueId); }
        binds.push(limit);
        const result = await env.DB.prepare(
          "SELECT source, fixture_id, league_id, league_name, country, kickoff, status, home_team_id, home_team, away_team_id, away_team, home_goals, away_goals FROM matches WHERE " +
          filters.join(" AND ") + " ORDER BY datetime(kickoff) ASC LIMIT ?"
        ).bind(...binds).all();
        const sourcePriority = source => {
          const value = String(source || "").toLowerCase();
          return value === "espn" ? 4 : value.includes("football-data") ? 3 : value === "api-football" ? 2 : 1;
        };
        const normalizeTeam = value => String(value || "").normalize("NFD").toLowerCase()
          .replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i")
          .replace(/[^a-z0-9]+/g, "").trim();
        const countryForLeague = (leagueId, leagueName, country, source) => canonicalLeagueCountry(source, leagueId, leagueName, country);
        const uniqueRows = new Map();
        for (const row of (Array.isArray(result?.results) ? result.results : [])) {
          const home = normalizeTeam(row.home_team), away = normalizeTeam(row.away_team);
          const time = Date.parse(String(row.kickoff || ""));
          const minute = Number.isFinite(time) ? Math.floor(time / 60000) : String(row.kickoff || "").slice(0, 16);
          const signature = home && away ? [minute, home, away].join("|") : String(row.source) + "|" + String(row.fixture_id);
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
        return new Response(JSON.stringify({
          ok: true, days, leagueId: leagueId || null, count: matches.length, rawCount: Array.isArray(result?.results) ? result.results.length : 0, duplicatesSuppressed: (Array.isArray(result?.results) ? result.results.length : 0) - matches.length, response: matches
        }), {
          status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
        });
      }

      if (path === "archive/matches" && request.method === "GET") {
        if (!env.DB) {
          return new Response(JSON.stringify({ error: "D1 binding DB is missing" }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const leagueId = String(url.searchParams.get("league") || "").trim();
        const before = String(url.searchParams.get("before") || new Date().toISOString()).slice(0, 40);
        const limitValue = Number.parseInt(url.searchParams.get("limit") || "1500", 10);
        const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(2000, limitValue)) : 1500;
        if (!leagueId) {
          return new Response(JSON.stringify({ error: "A league ID is required" }), {
            status: 400, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const archived = await env.DB.prepare(`
          SELECT source, fixture_id, league_id, league_name, country, kickoff, status,
                 home_team_id, home_team, away_team_id, away_team, home_goals, away_goals,
                 statistics_json, raw_json
          FROM matches
          WHERE league_id = ?
            AND date(kickoff) < date(?)
            AND home_goals IS NOT NULL
            AND away_goals IS NOT NULL
          ORDER BY datetime(kickoff) DESC
          LIMIT ?
        `).bind(leagueId, before, limit).all();
        const matches = (Array.isArray(archived?.results) ? archived.results : []).map(row => {
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
          ok: true, leagueId, count: matches.length, response: matches
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
        return new Response(JSON.stringify({ ok: true, count: matches.length, response: matches }), {
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
        const [total, statsCoverage, bySource, missingBySource, byLeague, byStatus, latest, summaryQueue, crossSourceStatsReport, summaryLastRun] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS total FROM matches").first(),
          env.DB.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN statistics_json IS NOT NULL AND statistics_json != '' AND statistics_json != 'null' AND (source != 'ESPN' OR CASE WHEN json_valid(statistics_json) = 1 THEN CASE WHEN COALESCE(json_array_length(json_extract(statistics_json, '$.teams[0].statistics')), 0) > 0 OR COALESCE(json_array_length(json_extract(statistics_json, '$.teams[1].statistics')), 0) > 0 THEN 1 ELSE 0 END ELSE 0 END = 1) THEN 1 ELSE 0 END) AS withStatistics, SUM(CASE WHEN status IN ('FT','AET','PEN','LIVE','1H','2H','HT','ET','P','INT') THEN 1 ELSE 0 END) AS eligibleTotal, SUM(CASE WHEN status IN ('FT','AET','PEN','LIVE','1H','2H','HT','ET','P','INT') AND statistics_json IS NOT NULL AND statistics_json != '' AND statistics_json != 'null' AND (source != 'ESPN' OR CASE WHEN json_valid(statistics_json) = 1 THEN CASE WHEN COALESCE(json_array_length(json_extract(statistics_json, '$.teams[0].statistics')), 0) > 0 OR COALESCE(json_array_length(json_extract(statistics_json, '$.teams[1].statistics')), 0) > 0 THEN 1 ELSE 0 END ELSE 0 END = 1) THEN 1 ELSE 0 END) AS eligibleWithStatistics FROM matches").first(),
          env.DB.prepare("SELECT source, COUNT(*) AS total FROM matches GROUP BY source ORDER BY source").all(),
          env.DB.prepare("SELECT source, COUNT(*) AS missing FROM matches WHERE status IN ('FT','AET','PEN','LIVE','1H','2H','HT','ET','P','INT') AND (statistics_json IS NULL OR statistics_json = '' OR statistics_json = 'null' OR (source = 'ESPN' AND (json_valid(statistics_json) = 0 OR (COALESCE(json_array_length(json_extract(statistics_json, '$.teams[0].statistics')), 0) = 0 AND COALESCE(json_array_length(json_extract(statistics_json, '$.teams[1].statistics')), 0) = 0)))) GROUP BY source ORDER BY missing DESC").all(),
          env.DB.prepare("SELECT league_id AS leagueId, league_name AS leagueName, country, COUNT(*) AS total, SUM(CASE WHEN status IN ('LIVE','1H','2H','HT','ET','P','INT') THEN 1 ELSE 0 END) AS live, SUM(CASE WHEN status IN ('FT','AET','PEN') AND home_goals IS NOT NULL AND away_goals IS NOT NULL THEN 1 ELSE 0 END) AS finished FROM matches GROUP BY league_id, league_name, country ORDER BY total DESC LIMIT 100").all(),
          env.DB.prepare("SELECT status, COUNT(*) AS total FROM matches GROUP BY status ORDER BY total DESC").all(),
          env.DB.prepare("SELECT MAX(updated_at) AS lastUpdated FROM matches").first(),
          env.MAM_KV ? env.MAM_KV.get("mam:espn-summary-queue:v1", "json") : Promise.resolve([]),
          env.MAM_KV ? env.MAM_KV.get("mam:cross-source-stats:last:v1", "json") : Promise.resolve(null),
          env.MAM_KV ? env.MAM_KV.get("mam:espn-summary-last-run:v1", "json") : Promise.resolve(null)
        ]);
        const statsTotal = Number(statsCoverage?.total || 0);
        const statsWith = Number(statsCoverage?.withStatistics || 0);
        const queueItems = Array.isArray(summaryQueue) ? summaryQueue : [];
        const queueNow = Date.now();
        const queueReady = queueItems.filter(item => Number(item?.retryAfter || 0) <= queueNow);
        const queueCoolingDown = queueItems.filter(item => Number(item?.retryAfter || 0) > queueNow);
        const queueRetryAttempts = queueItems.reduce((counts, item) => {
          const attempt = String(Number(item?.attempts || 0));
          counts[attempt] = (counts[attempt] || 0) + 1;
          return counts;
        }, {});
        const nextQueueRetryAt = queueCoolingDown.length
          ? new Date(Math.min(...queueCoolingDown.map(item => Number(item.retryAfter || 0)))).toISOString()
          : null;
        return new Response(JSON.stringify({
          ok: true,
          total: Number(total?.total || 0),
          statistics: {
            withStatistics: statsWith,
            missingStatistics: Math.max(0, statsTotal - statsWith),
            coveragePercent: statsTotal ? Math.round(statsWith / statsTotal * 1000) / 10 : 0,
            eligibleMatches: Number(statsCoverage?.eligibleTotal || 0),
            eligibleWithStatistics: Number(statsCoverage?.eligibleWithStatistics || 0),
            eligibleMissingStatistics: Math.max(0, Number(statsCoverage?.eligibleTotal || 0) - Number(statsCoverage?.eligibleWithStatistics || 0)),
            eligibleCoveragePercent: Number(statsCoverage?.eligibleTotal || 0) ? Math.round(Number(statsCoverage?.eligibleWithStatistics || 0) / Number(statsCoverage.eligibleTotal) * 1000) / 10 : 0
          },
          crossSourceStatisticsEnrichment: crossSourceStatsReport || null,
          espnSummaryLastRun: summaryLastRun || null,
          pendingSummaryRetries: queueItems.length,
          summaryQueueStatus: {
            queued: queueItems.length,
            readyToRetry: queueReady.length,
            coolingDown: queueCoolingDown.length,
            retryAttempts: queueRetryAttempts,
            nextRetryAt: nextQueueRetryAt
          },
          lastUpdated: latest?.lastUpdated || null,
          sources: Array.isArray(bySource?.results) ? bySource.results : [],
          missingStatisticsBySource: Array.isArray(missingBySource?.results) ? missingBySource.results : [],
          leagues: Array.isArray(byLeague?.results) ? byLeague.results : [],
          statuses: Array.isArray(byStatus?.results) ? byStatus.results : []
        }), {
          status: 200,
          headers: {
            ...cors,
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0"
          }
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
      const apiPath = isESPN
        ? path.slice("espn/".length)
        : isFootballData
          ? path.slice("football-data/".length)
          : isFixtureDownload
            ? path.slice("fixturesdownload/".length)
            : path;

      const apiKey = isESPN || isFixtureDownload
        ? null
        : isFootballData
          ? env.FOOTBALLDATA_API_KEY
          : env.API_FOOTBALL_KEY;

      // ESPN and public FixtureDownload feeds do not require an API key.
      // Only API-Football and football-data.org require their respective secrets.
      if (!isESPN && !isFixtureDownload && !apiKey) {
        return new Response(JSON.stringify({
          error: isFootballData
            ? "FOOTBALLDATA_API_KEY secret is missing"
            : "API_FOOTBALL_KEY secret is missing"
        }), {
          status: 500,
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }

      const isESPNStandings = isESPN && apiPath.endsWith("/standings");
      const base = isFixtureDownload ? "https://fixturedownload.com/feed/json" : isESPNStandings ? "https://site.api.espn.com/apis/v2/sports/soccer" : isESPN ? ESPN_BASE : isFootballData ? FOOTBALLDATA_BASE : API_BASE;
      const targetUrl = base + "/" + apiPath + url.search;
      const isStandings = /(^|\/)standings$/.test(apiPath);
      const footballDataStatuses = (url.searchParams.get("status") || "").split(",").map(value => value.trim().toUpperCase());
      const isLive = url.searchParams.get("live") === "all" || (isFootballData && apiPath === "matches" && footballDataStatuses.some(value => ["LIVE", "IN_PLAY", "PAUSED"].includes(value)));
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

      const upstreamHeaders = (isESPN || isFixtureDownload)
        ? { "Accept": "application/json" }
        : isFootballData
          ? { "X-Auth-Token": apiKey }
          : { "x-apisports-key": apiKey };

      const upstream = await fetch(targetUrl, {
        method: "GET",
        headers: upstreamHeaders
      });

      const responseHeaders = new Headers(cors);
      responseHeaders.set(
        "Content-Type",
        upstream.headers.get("Content-Type") || "application/json; charset=utf-8"
      );

      const response = new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders
      });

      if (upstream.ok && cache) {
        const cacheHeaders = new Headers(response.headers);
        const responseCacheSeconds = isLive ? 60 : isLineupData ? 300 : isESPN && apiPath === "summary" ? 300 : isLiveStats ? 60 : isESPN ? 900 : isStandings ? STANDINGS_CACHE_SECONDS : CACHE_SECONDS;
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
