// Isolated historical fixture discovery queue.
// This module only creates and reports work items. It does not execute ESPN requests
// or write match rows; the live ESPN sync and statistics queues remain untouched.
export const HISTORY_BACKFILL_KEY = "mam:history-backfill-state:v1";
const HISTORY_ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
export const HISTORY_BACKFILL_START = "2024-07-01";

export const HISTORY_BACKFILL_LEAGUES = [
  ["39","eng.1","Premier League","England"], ["40","eng.2","Championship","England"],
  ["45","eng.fa","FA Cup","England"], ["48","eng.league_cup","EFL Cup","England"],
  ["140","esp.1","La Liga","Spain"], ["141","esp.2","La Liga 2","Spain"],
  ["143","esp.copa_del_rey","Copa del Rey","Spain"],
  ["78","ger.1","Bundesliga","Germany"], ["79","ger.2","2. Bundesliga","Germany"],
  ["81","ger.dfb_pokal","DFB Pokal","Germany"],
  ["135","ita.1","Serie A","Italy"], ["136","ita.2","Serie B","Italy"],
  ["137","ita.coppa_italia","Coppa Italia","Italy"],
  ["61","fra.1","Ligue 1","France"], ["62","fra.2","Ligue 2","France"],
  ["66","fra.coupe_de_france","Coupe de France","France"],
  ["2","uefa.champions","UEFA Champions League","Europe"],
  ["3","uefa.europa","UEFA Europa League","Europe"],
  ["848","uefa.europa.conf","UEFA Conference League","Europe"],
  ["94","por.1","Primeira Liga","Portugal"], ["88","ned.1","Eredivisie","Netherlands"],
  ["144","bel.1","Belgian Pro League","Belgium"], ["203","tur.1","Süper Lig","Türkiye"],
  ["204","tur.2","1. Lig","Türkiye"], ["179","sco.1","Scottish Premiership","Scotland"],
  ["253","usa.1","MLS","USA"], ["71","bra.1","Brasileirão","Brazil"],
  ["128","arg.1","Liga Profesional","Argentina"], ["262","mex.1","Liga MX","Mexico"],
  ["98","jpn.1","J1 League","Japan"], ["188","aus.1","A-League","Australia"],
  ["169","chn.1","Chinese Super League","China"], ["1","fifa.world","FIFA World Cup","World"],
  ["4","uefa.euro","UEFA European Championship","Europe"],
  ["5","uefa.nations","UEFA Nations League","Europe"],
  ["6","caf.nations","Africa Cup of Nations","Africa"],
  ["15","fifa.cwc","FIFA Club World Cup","World"], ["307","ksa.1","Saudi Pro League","Saudi Arabia"]
];

export function buildHistoryBackfillState(now = new Date()) {
  const start = new Date(HISTORY_BACKFILL_START + "T12:00:00.000Z");
  const end = new Date(now);
  end.setUTCHours(12, 0, 0, 0);
  const dayCount = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
  return {
    version: 1,
    createdAt: now.toISOString(),
    rangeStart: HISTORY_BACKFILL_START,
    rangeEnd: end.toISOString().slice(0, 10),
    dayCount,
    seasonsRequested: ["2024/25", "2025/26", "2026/27"],
    leagueCount: HISTORY_BACKFILL_LEAGUES.length,
    totalJobs: HISTORY_BACKFILL_LEAGUES.length * dayCount,
    cursor: 0,
    status: "queued",
    executionEnabled: false,
    note: "Compact queue metadata only. Jobs are generated deterministically in bounded batches; no match data is fetched or written."
  };
}

// Generate only the requested slice; never materialize the entire multi-season queue.
export function getHistoryBackfillBatch(state, limit = 20) {
  const start = new Date(state.rangeStart + "T12:00:00.000Z");
  const dayCount = Number(state.dayCount || 0);
  const totalJobs = Number(state.totalJobs || 0);
  const cursor = Math.max(0, Number(state.cursor || 0));
  if (!Number.isInteger(dayCount) || dayCount < 1 || !Number.isFinite(totalJobs) || totalJobs < 1) return [];
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
  const jobs = [];
  for (let index = cursor; index < Math.min(totalJobs, cursor + safeLimit); index++) {
    const league = HISTORY_BACKFILL_LEAGUES[Math.floor(index / dayCount)];
    const day = new Date(start);
    day.setUTCDate(day.getUTCDate() + (index % dayCount));
    jobs.push({ league, date: day.toISOString().slice(0, 10).replace(/-/g, ""), attempts: 0 });
  }
  return jobs;
}


// Read-only upstream probe: checks whether ESPN accepts a bounded multi-day
// scoreboard range. It never touches D1, KV, or the historical queue.
export async function probeHistoryBackfillRange({ leagueSlug = "eng.1", dateFrom, dateTo }, fetchImpl = fetch) {
  const league = HISTORY_BACKFILL_LEAGUES.find(item => item[1] === leagueSlug);
  const validDate = value => /^\\d{8}$/.test(String(value || "")) &&
    !Number.isNaN(Date.parse(String(value).slice(0, 4) + "-" + String(value).slice(4, 6) + "-" + String(value).slice(6, 8) + "T00:00:00Z"));
  if (!league || !validDate(dateFrom) || !validDate(dateTo)) {
    return { ok: false, status: "invalid-input", reason: "Use a configured ESPN league and YYYYMMDD dates." };
  }
  const from = Date.parse(dateFrom.slice(0,4) + "-" + dateFrom.slice(4,6) + "-" + dateFrom.slice(6,8) + "T00:00:00Z");
  const to = Date.parse(dateTo.slice(0,4) + "-" + dateTo.slice(4,6) + "-" + dateTo.slice(6,8) + "T00:00:00Z");
  const daySpan = Math.floor((to - from) / 86400000) + 1;
  if (daySpan < 1 || daySpan > 7) {
    return { ok: false, status: "invalid-range", reason: "Probe range must be between 1 and 7 days." };
  }
  const url = HISTORY_ESPN_BASE + "/" + leagueSlug + "/scoreboard?dates=" + dateFrom + "-" + dateTo + "&limit=500";
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(12000)
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch (_) {}
    if (!response.ok) {
      return { ok: false, status: "upstream-http-error", httpStatus: response.status, contentType: response.headers?.get?.("content-type") || null, detail: text.slice(0, 240) };
    }
    if (!payload || !Array.isArray(payload.events)) {
      return { ok: false, status: "unexpected-response", httpStatus: response.status, detail: text.slice(0, 240) };
    }
    return {
      ok: true, status: "range-supported-response", httpStatus: response.status,
      league: league[2], dateFrom, dateTo, daySpan,
      eventCount: payload.events.length,
      sampleEvents: payload.events.slice(0, 3).map(event => ({
        id: String(event.id || ""),
        date: event.date || null,
        name: event.name || event.shortName || null
      })),
      note: "Read-only probe; no D1/KV writes and no queue progress."
    };
  } catch (error) {
    return { ok: false, status: "network-error", detail: String(error?.message || error).slice(0, 240) };
  }
}

// One manually-invoked, tightly bounded batch. The feature flag is deliberately
// absent from source control; it must be explicitly set in the Worker environment.
export async function runHistoryBackfillBatch(env, fetchImpl = fetch) {
  if (env.HISTORY_BACKFILL_ENABLED !== "true") {
    return { ok: false, status: "disabled", reason: "Set HISTORY_BACKFILL_ENABLED=true only after isolated Preview verification." };
  }
  if (!env.DB || !env.MAM_KV) {
    return { ok: false, status: "unavailable", reason: "D1 and KV bindings are required." };
  }

  const state = await env.MAM_KV.get(HISTORY_BACKFILL_KEY, "json");
  if (!state || !Number.isInteger(Number(state.totalJobs)) || Number(state.totalJobs) < 1) {
    return { ok: false, status: "not-initialized" };
  }
  if (state.executionEnabled !== true) {
    return { ok: false, status: "not-enabled", reason: "Enable the queue explicitly before running a batch." };
  }
  if (Number(state.cursor || 0) >= Number(state.totalJobs)) {
    return { ok: true, status: "complete", processedJobs: Number(state.cursor || 0), totalJobs: Number(state.totalJobs) };
  }

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS mam_history_backfill_lock (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0)"
  ).run();
  // Stage history separately so the live statistics-recovery queue cannot consume it.
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS mam_history_backfill_matches (source TEXT NOT NULL, fixture_id TEXT NOT NULL, league_id TEXT, league_name TEXT, country TEXT, kickoff TEXT, status TEXT, home_team_id TEXT, home_team TEXT, away_team_id TEXT, away_team TEXT, home_goals INTEGER, away_goals INTEGER, raw_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (source, fixture_id))"
  ).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO mam_history_backfill_lock (id, owner, lease_until) VALUES (1, '', 0)"
  ).run();

  const owner = crypto.randomUUID();
  const now = Date.now();
  const leaseUntil = now + 120000;
  const claim = await env.DB.prepare(
    "UPDATE mam_history_backfill_lock SET owner = ?, lease_until = ? WHERE id = 1 AND lease_until < ?"
  ).bind(owner, leaseUntil, now).run();
  if (Number(claim?.meta?.changes || 0) !== 1) {
    return { ok: false, status: "locked", reason: "Another historical batch holds the D1 lease." };
  }

  try {
    const cursor = Math.max(0, Number(state.cursor || 0));
    const batch = getHistoryBackfillBatch(state, 4);
    if (!batch.length) return { ok: false, status: "invalid-queue", cursor };

    const rows = [];
    const failures = [];
    for (let i = 0; i < batch.length; i += 2) {
      await Promise.all(batch.slice(i, i + 2).map(async (job, offset) => {
        const jobIndex = i + offset;
        const [leagueId, slug, leagueName, country] = job.league || [];
        try {
          if (!slug || !/^\d{8}$/.test(job.date)) throw new Error("Invalid league/date job");
          const response = await fetchImpl(HISTORY_ESPN_BASE + "/" + slug + "/scoreboard?dates=" + job.date + "&limit=500", {
            headers: { Accept: "application/json" }
          });
          if (!response.ok) throw new Error("ESPN HTTP " + response.status);
          const payload = await response.json();
          for (const event of (Array.isArray(payload?.events) ? payload.events : [])) {
            const competition = (event.competitions || [])[0] || {};
            const competitors = competition.competitors || [];
            const home = competitors.find(item => item.homeAway === "home") || {};
            const away = competitors.find(item => item.homeAway === "away") || {};
            const homeName = String(home.team?.displayName || home.team?.name || "").trim();
            const awayName = String(away.team?.displayName || away.team?.name || "").trim();
            if (!homeName || !awayName || !event.id || !event.date) continue;
            const type = event.status?.type || competition.status?.type || {};
            const phase = String(type.state || "").toLowerCase();
            const status = type.completed === true || phase === "post" ? "FT" : (phase === "in" || phase === "live") ? "LIVE" : "NS";
            const score = value => value == null || value === "" ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
            rows.push({
              fixtureId: "espn-" + slug + "-" + String(event.id),
              leagueId, leagueName, country, kickoff: String(event.date), status,
              homeId: home.team?.id == null ? null : String(home.team.id), homeName,
              awayId: away.team?.id == null ? null : String(away.team.id), awayName,
              homeGoals: score(home.score), awayGoals: score(away.score), raw: JSON.stringify(event)
            });
          }
        } catch (error) {
          failures.push({ index: jobIndex, date: job.date, league: slug || null, error: String(error?.message || error) });
        }
      }));
    }

    const sql = "INSERT INTO mam_history_backfill_matches (source, fixture_id, league_id, league_name, country, kickoff, status, home_team_id, home_team, away_team_id, away_team, home_goals, away_goals, raw_json) VALUES ('ESPN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, fixture_id) DO UPDATE SET league_id=excluded.league_id, league_name=excluded.league_name, country=excluded.country, kickoff=excluded.kickoff, status=CASE WHEN mam_history_backfill_matches.status IN ('FT','AET','PEN') AND excluded.status='NS' THEN mam_history_backfill_matches.status ELSE excluded.status END, home_team_id=COALESCE(excluded.home_team_id,mam_history_backfill_matches.home_team_id), home_team=excluded.home_team, away_team_id=COALESCE(excluded.away_team_id,mam_history_backfill_matches.away_team_id), away_team=excluded.away_team, home_goals=COALESCE(excluded.home_goals,mam_history_backfill_matches.home_goals), away_goals=COALESCE(excluded.away_goals,mam_history_backfill_matches.away_goals), raw_json=excluded.raw_json, updated_at=CURRENT_TIMESTAMP";
    let saved = 0;
    for (let i = 0; i < rows.length; i += 50) {
      const statements = rows.slice(i, i + 50).map(row => env.DB.prepare(sql).bind(
        row.fixtureId, row.leagueId, row.leagueName, row.country, row.kickoff, row.status,
        row.homeId, row.homeName, row.awayId, row.awayName, row.homeGoals, row.awayGoals, row.raw
      ));
      const result = await env.DB.batch(statements);
      saved += result.reduce((sum, item) => sum + (Number(item?.meta?.changes) || 0), 0);
    }

    // Advance only through the successful contiguous prefix. Later successful
    // rows are safe to upsert again if an earlier date must be retried.
    const firstFailure = failures.length ? Math.min(...failures.map(item => item.index)) : batch.length;
    const advanced = Math.max(0, Math.min(batch.length, firstFailure));
    const nextCursor = cursor + advanced;
    const nextState = {
      ...state,
      cursor: nextCursor,
      status: nextCursor >= Number(state.totalJobs) ? "complete" : (failures.length ? "retry-needed" : "queued"),
      lastRunAt: new Date().toISOString(),
      lastBatch: { requested: batch.length, advanced, saved, failures }
    };
    await env.MAM_KV.put(HISTORY_BACKFILL_KEY, JSON.stringify(nextState));
    return {
      ok: true, status: nextState.status, requested: batch.length, advanced,
      processedJobs: nextCursor, totalJobs: Number(state.totalJobs),
      remainingJobs: Math.max(0, Number(state.totalJobs) - nextCursor), saved, failures
    };
  } finally {
    await env.DB.prepare(
      "UPDATE mam_history_backfill_lock SET owner = '', lease_until = 0 WHERE id = 1 AND owner = ?"
    ).bind(owner).run();
  }
}
