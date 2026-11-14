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
  ["9","conmebol.america","Copa América","South America"],
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
  const validDate = value => /^\d{8}$/.test(String(value || "")) &&
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
  const dateParam = dateFrom === dateTo ? dateFrom : dateFrom + "-" + dateTo;
  const url = HISTORY_ESPN_BASE + "/" + leagueSlug + "/scoreboard?dates=" + dateParam + "&limit=500";
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


// Read-only coverage audit in small batches to avoid stressing ESPN or Worker limits.
export async function probeHistoryBackfillBatch({ offset = 0, limit = 5, date }, fetchImpl = fetch) {
  const validDate = value => /^\d{8}$/.test(String(value || "")) &&
    !Number.isNaN(Date.parse(String(value).slice(0, 4) + "-" + String(value).slice(4, 6) + "-" + String(value).slice(6, 8) + "T00:00:00Z"));
  if (!Number.isInteger(offset) || offset < 0 || offset >= HISTORY_BACKFILL_LEAGUES.length ||
      !Number.isInteger(limit) || limit < 1 || limit > 5 || !validDate(date)) {
    return { ok: false, status: "invalid-input", reason: "Use a valid date, offset, and limit from 1 to 5." };
  }
  const selected = HISTORY_BACKFILL_LEAGUES.slice(offset, offset + limit);
  const results = await Promise.all(selected.map(league =>
    probeHistoryBackfillRange({ leagueSlug: league[1], dateFrom: date, dateTo: date }, fetchImpl)
  ));
  const successCount = results.filter(result => result.ok).length;
  return {
    ok: true, status: "coverage-batch-complete", date, offset, requested: selected.length,
    totalLeagues: HISTORY_BACKFILL_LEAGUES.length, successCount,
    failureCount: results.length - successCount, results,
    note: "Read-only coverage audit; no D1/KV writes and no queue progress."
  };
}

// Fixed, one-day pilot: four leagues already verified by the read-only probe.
// It does not read or advance the general historical queue.
export const HISTORY_BACKFILL_PILOT = {
  date: "20261101",
  leagues: [
    ["39", "eng.1", "Premier League", "England"],
    ["140", "esp.1", "La Liga", "Spain"],
    ["78", "ger.1", "Bundesliga", "Germany"],
    ["203", "tur.1", "Süper Lig", "Türkiye"]
  ]
};

export async function runHistoryBackfillPilot(env, fetchImpl = fetch) {
  if (env.HISTORY_BACKFILL_PILOT_ENABLED !== "true") {
    return { ok: false, status: "pilot-disabled", reason: "Pilot is disabled until explicitly enabled in isolated Preview." };
  }
  if (!env.DB) return { ok: false, status: "unavailable", reason: "Preview D1 binding is required." };

  const rows = [];
  const leagueResults = [];
  for (const [leagueId, slug, leagueName, country] of HISTORY_BACKFILL_PILOT.leagues) {
    try {
      const response = await fetchImpl(HISTORY_ESPN_BASE + "/" + slug + "/scoreboard?dates=" + HISTORY_BACKFILL_PILOT.date + "&limit=500", {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(12000)
      });
      if (!response.ok) {
        return { ok: false, status: "upstream-http-error", league: slug, httpStatus: response.status, saved: 0, note: "No D1 writes were made." };
      }
      const payload = await response.json();
      if (!payload || !Array.isArray(payload.events) || payload.events.length === 0) {
        return { ok: false, status: "empty-or-invalid-upstream", league: slug, saved: 0, note: "No D1 writes were made; an empty response is not treated as completed coverage." };
      }
      let accepted = 0;
      for (const event of payload.events) {
        const competition = (event.competitions || [])[0] || {};
        const competitors = competition.competitors || [];
        const home = competitors.find(item => item.homeAway === "home") || {};
        const away = competitors.find(item => item.homeAway === "away") || {};
        const homeName = String(home.team?.displayName || home.team?.name || "").trim();
        const awayName = String(away.team?.displayName || away.team?.name || "").trim();
        if (!event.id || !event.date || !homeName || !awayName) continue;
        const eventDate = String(event.date).slice(0, 10).replace(/-/g, "");
        if (eventDate !== HISTORY_BACKFILL_PILOT.date) continue;
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
        accepted++;
      }
      if (!accepted) {
        return { ok: false, status: "invalid-events", league: slug, saved: 0, note: "No D1 writes were made; returned events did not pass validation." };
      }
      leagueResults.push({ league: leagueName, eventCount: payload.events.length, validMatches: accepted });
    } catch (error) {
      return { ok: false, status: "upstream-error", league: slug, detail: String(error?.message || error).slice(0, 200), saved: 0, note: "No D1 writes were made." };
    }
  }

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS mam_history_backfill_matches (source TEXT NOT NULL, fixture_id TEXT NOT NULL, league_id TEXT, league_name TEXT, country TEXT, kickoff TEXT, status TEXT, home_team_id TEXT, home_team TEXT, away_team_id TEXT, away_team TEXT, home_goals INTEGER, away_goals INTEGER, raw_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (source, fixture_id))"
  ).run();

  const sql = "INSERT INTO mam_history_backfill_matches (source, fixture_id, league_id, league_name, country, kickoff, status, home_team_id, home_team, away_team_id, away_team, home_goals, away_goals, raw_json) VALUES ('ESPN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, fixture_id) DO UPDATE SET league_id=excluded.league_id, league_name=excluded.league_name, country=excluded.country, kickoff=excluded.kickoff, status=CASE WHEN mam_history_backfill_matches.status IN ('FT','AET','PEN') AND excluded.status='NS' THEN mam_history_backfill_matches.status ELSE excluded.status END, home_team_id=COALESCE(excluded.home_team_id,mam_history_backfill_matches.home_team_id), home_team=excluded.home_team, away_team_id=COALESCE(excluded.away_team_id,mam_history_backfill_matches.away_team_id), away_team=excluded.away_team, home_goals=COALESCE(excluded.home_goals,mam_history_backfill_matches.home_goals), away_goals=COALESCE(excluded.away_goals,mam_history_backfill_matches.away_goals), raw_json=excluded.raw_json, updated_at=CURRENT_TIMESTAMP";
  const statements = rows.map(row => env.DB.prepare(sql).bind(
    row.fixtureId, row.leagueId, row.leagueName, row.country, row.kickoff, row.status,
    row.homeId, row.homeName, row.awayId, row.awayName, row.homeGoals, row.awayGoals, row.raw
  ));
  const results = await env.DB.batch(statements);
  const changes = results.reduce((sum, item) => sum + (Number(item?.meta?.changes) || 0), 0);
  return {
    ok: true, status: "pilot-staged", date: HISTORY_BACKFILL_PILOT.date,
    fetchedMatches: rows.length, databaseChanges: changes,
    leagues: leagueResults,
    idempotentKey: "ESPN source + league-scoped fixture ID",
    note: "Preview staging only. Main matches table and general history queue were not modified."
  };
}

// One manually-invoked, tightly bounded batch. The feature flag is deliberately
// absent from source control; it must be explicitly set in the Worker environment.
// Bounded processor: successful empty days count as completed coverage, while
// transport/HTTP/schema failures enter a delayed retry queue. New discovery keeps
// moving so one bad upstream day cannot block thousands of later dates.
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

  const cursor = Math.max(0, Number(state.cursor || 0));
  const totalJobs = Number(state.totalJobs);
  const pendingRetries = Array.isArray(state.retryJobs) ? state.retryJobs : [];
  const deadLetters = Array.isArray(state.deadLetters) ? state.deadLetters : [];
  if (cursor >= totalJobs && pendingRetries.length === 0) {
    return { ok: true, status: deadLetters.length ? "needs-review" : "complete",
      processedJobs: cursor, totalJobs, pendingRetries: 0, deadLetters: deadLetters.length };
  }

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS mam_history_backfill_lock (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS mam_history_backfill_matches (source TEXT NOT NULL, fixture_id TEXT NOT NULL, league_id TEXT, league_name TEXT, country TEXT, kickoff TEXT, status TEXT, home_team_id TEXT, home_team TEXT, away_team_id TEXT, away_team TEXT, home_goals INTEGER, away_goals INTEGER, raw_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (source, fixture_id))"
  ).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO mam_history_backfill_lock (id, owner, lease_until) VALUES (1, '', 0)"
  ).run();

  const owner = crypto.randomUUID();
  const now = Date.now();
  const claim = await env.DB.prepare(
    "UPDATE mam_history_backfill_lock SET owner = ?, lease_until = ? WHERE id = 1 AND lease_until < ?"
  ).bind(owner, now + 180000, now).run();
  if (Number(claim?.meta?.changes || 0) !== 1) {
    return { ok: false, status: "locked", reason: "Another historical batch holds the D1 lease." };
  }

  try {
    const batchLimit = 10;
    const readyRetries = pendingRetries.filter(job => Number(job.retryAfter || 0) <= now)
      .sort((a, b) => Number(a.retryAfter || 0) - Number(b.retryAfter || 0));
    const retryBatch = readyRetries.slice(0, batchLimit);
    const retryKeys = new Set(retryBatch.map(job => job.index));
    const newSlots = Math.max(0, batchLimit - retryBatch.length);
    const newBatch = cursor < totalJobs && newSlots > 0 ? getHistoryBackfillBatch({ ...state, cursor }, newSlots) : [];
    const batch = [
      ...retryBatch.map(job => ({ ...job, isRetry: true })),
      ...newBatch.map((job, index) => ({ ...job, index: cursor + index, isRetry: false }))
    ];
    if (!batch.length) {
      const nextState = { ...state, status: "retry-wait", lastRunAt: new Date().toISOString(),
        pendingRetries: pendingRetries.length, retryJobs: pendingRetries };
      await env.MAM_KV.put(HISTORY_BACKFILL_KEY, JSON.stringify(nextState));
      return { ok: true, status: "retry-wait", processedJobs: cursor, totalJobs,
        pendingRetries: pendingRetries.length, nextRetryAt: new Date(Math.min(...pendingRetries.map(x => Number(x.retryAfter || now)))).toISOString() };
    }

    const rows = [];
    const failures = [];
    let emptyDays = 0;
    let successfulDays = 0;
    const completedRetryIndexes = new Set();
    const failedRetryIndexes = new Set();
    for (let i = 0; i < batch.length; i += 3) {
      await Promise.all(batch.slice(i, i + 3).map(async job => {
        const [leagueId, slug, leagueName, country] = job.league || [];
        try {
          if (!slug || !/^\d{8}$/.test(job.date)) throw new Error("Invalid league/date job");
          const response = await fetchImpl(HISTORY_ESPN_BASE + "/" + slug + "/scoreboard?dates=" + job.date + "&limit=500", {
            headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000)
          });
          if (!response.ok) throw new Error("ESPN HTTP " + response.status);
          const payload = await response.json();
          if (!payload || !Array.isArray(payload.events)) throw new Error("ESPN response did not contain an events array");
          if (payload.events.length === 0) {
            emptyDays++;
            successfulDays++;
            if (job.isRetry) completedRetryIndexes.add(job.index);
            return;
          }
          let acceptedEvents = 0;
          for (const event of payload.events) {
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
            acceptedEvents++;
          }
          if (!acceptedEvents) throw new Error("ESPN events contained no valid fixtures");
          successfulDays++;
          if (job.isRetry) completedRetryIndexes.add(job.index);
        } catch (error) {
          const attempts = Number(job.attempts || 0) + 1;
          const message = String(error?.message || error).slice(0, 240);
          failures.push({ index: job.index, date: job.date, league: slug || null, attempts, error: message });
          if (job.isRetry) failedRetryIndexes.add(job.index);
          job.nextAttempts = attempts;
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

    const retryMap = new Map(pendingRetries.map(job => [job.index, job]));
    for (const index of completedRetryIndexes) retryMap.delete(index);
    const nextDeadLetters = [...deadLetters];
    for (const failure of failures) {
      const job = batch.find(item => item.index === failure.index);
      const attempts = Number(job?.nextAttempts || failure.attempts);
      if (attempts >= 5) {
        retryMap.delete(failure.index);
        nextDeadLetters.push({ index: failure.index, date: failure.date, league: failure.league,
          attempts, error: failure.error, exhaustedAt: new Date().toISOString() });
      } else {
        const delayMs = Math.min(60 * 60 * 1000, 60 * 1000 * (2 ** (attempts - 1)));
        retryMap.set(failure.index, {
          index: failure.index, league: job.league, date: job.date, attempts,
          retryAfter: now + delayMs, lastError: failure.error
        });
      }
    }
    let advancedNewJobs = 0;
    for (const job of batch) if (!job.isRetry) advancedNewJobs++;
    const nextCursor = Math.min(totalJobs, cursor + advancedNewJobs);
    const retryJobs = [...retryMap.values()].sort((a, b) => a.index - b.index);
    const status = nextDeadLetters.length ? "needs-review" :
      retryJobs.length ? "retry-needed" : nextCursor >= totalJobs ? "complete" : "queued";
    const nextState = {
      ...state, cursor: nextCursor, retryJobs, deadLetters: nextDeadLetters,
      status, lastRunAt: new Date().toISOString(),
      lastBatch: { requested: batch.length, newJobs: advancedNewJobs, successfulDays, emptyDays,
        saved, failures, pendingRetries: retryJobs.length, deadLetters: nextDeadLetters.length }
    };
    await env.MAM_KV.put(HISTORY_BACKFILL_KEY, JSON.stringify(nextState));
    return {
      ok: true, status, requested: batch.length, advanced: advancedNewJobs,
      successfulDays, emptyDays, processedJobs: nextCursor, totalJobs,
      remainingJobs: Math.max(0, totalJobs - nextCursor), saved,
      pendingRetries: retryJobs.length, deadLetters: nextDeadLetters.length, failures
    };
  } finally {
    await env.DB.prepare(
      "UPDATE mam_history_backfill_lock SET owner = '', lease_until = 0 WHERE id = 1 AND owner = ?"
    ).bind(owner).run();
  }
}
