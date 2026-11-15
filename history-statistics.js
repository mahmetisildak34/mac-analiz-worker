import { HISTORY_BACKFILL_LEAGUES } from "./history-backfill.js";

export const HISTORY_STATISTICS_KEY = "mam:history-statistics-state:v1";
export const HISTORY_STATISTICS_LOCK_TABLE = "mam_history_backfill_statistics_lock";
export const NATIONAL_TEAM_COMPETITION_IDS = Object.freeze(["1", "4", "5", "9", "6"]);

export const NATIONAL_TEAM_COMPETITIONS = Object.freeze(
  HISTORY_BACKFILL_LEAGUES.filter(item => NATIONAL_TEAM_COMPETITION_IDS.includes(String(item[0])))
);
export const CLUB_COMPETITIONS = Object.freeze(
  HISTORY_BACKFILL_LEAGUES.filter(item => !NATIONAL_TEAM_COMPETITION_IDS.includes(String(item[0])))
);

export const CLUB_HISTORY_BACKFILL_KEY = "mam:club-history-backfill-state:v2";
export const NATIONAL_TEAM_HISTORY_BACKFILL_KEY = "mam:national-team-history-backfill-state:v2";

export function getHistoryBackfillQueueConfig(scope) {
  if (scope === "clubs") return { key: CLUB_HISTORY_BACKFILL_KEY, scope: "club-competitions", leagues: CLUB_COMPETITIONS };
  if (scope === "national-teams") return { key: NATIONAL_TEAM_HISTORY_BACKFILL_KEY, scope: "national-team-competitions", leagues: NATIONAL_TEAM_COMPETITIONS };
  return null;
}

export function buildHistoryBackfillScopedState(scope, now = new Date()) {
  const config = getHistoryBackfillQueueConfig(scope);
  if (!config) throw new Error("Unknown history backfill scope. Use clubs or national-teams.");
  const rangeStart = "2024-07-01";
  const start = new Date(rangeStart + "T12:00:00.000Z");
  const end = new Date(now);
  end.setUTCHours(12, 0, 0, 0);
  const dayCount = Math.floor((end.getTime() - start.getTime()) / 86400000) + 1;
  return {
    version: 2, scope: config.scope, createdAt: now.toISOString(),
    rangeStart, rangeEnd: end.toISOString().slice(0, 10), dayCount,
    seasonsRequested: ["2024/25", "2025/26", "2026/27"],
    leagueCount: config.leagues.length, totalJobs: config.leagues.length * dayCount,
    cursor: 0, status: "queued", executionEnabled: false,
    retryJobs: [], deadLetters: [],
    note: "Breadth-first date slices cover all competitions early while preserving configured priority order. Category queues are isolated; live matches are not modified."
  };
}

export function normalizeHistoryStatisticsForApp(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.home || raw.away) return raw;
  const teams = Array.isArray(raw.teams) ? raw.teams : [];
  if (!teams.length) return Array.isArray(raw) ? raw : null;
  const normalizeName = value => String(value || "").toLowerCase().replace(/[^a-z]/g, "");
  const readTeam = homeAway => {
    const team = teams.find(item => item.homeAway === homeAway);
    const result = {};
    for (const stat of (Array.isArray(team?.statistics) ? team.statistics : [])) {
      const key = normalizeName(stat.name || stat.abbreviation || stat.type);
      const rawValue = stat.displayValue ?? stat.value;
      const number = Number(String(rawValue ?? "").replace(/,/g, "").replace("%", ""));
      if (rawValue === null || rawValue === undefined || rawValue === "" || !Number.isFinite(number)) continue;
      if (/corner/.test(key)) result.corners = number;
      else if (/shotsontarget|shotsongoal|ontarget/.test(key)) result.shotsOnTarget = number;
      else if (/totalshots|shots$/.test(key)) result.shots = number;
      else if (/yellowcard/.test(key)) result.yellowCards = number;
      else if (/redcard/.test(key)) result.redCards = number;
    }
    return result;
  };
  const home = teams.find(item => item.homeAway === "home");
  const away = teams.find(item => item.homeAway === "away");
  if (!home || !away) return null;
  return { home: readTeam("home"), away: readTeam("away"), coverage: raw.coverage || null };
}

export function classifyHistoryCompetition(leagueId) {
  return NATIONAL_TEAM_COMPETITION_IDS.includes(String(leagueId)) ? "national-team" : "club";
}

export function getHistoryCompetitionCatalog() {
  return {
    total: HISTORY_BACKFILL_LEAGUES.length,
    nationalTeams: NATIONAL_TEAM_COMPETITIONS.map(([id, slug, name, country], index) => ({
      rank: index + 1, id, slug, name, country, category: "national-team"
    })),
    clubs: CLUB_COMPETITIONS.map(([id, slug, name, country], index) => ({
      rank: index + 1, id, slug, name, country, category: "club",
      priority: index < 9 ? "high" : "standard"
    })),
    externalFallback: [{
      id: "206", name: "Türkiye Kupası", country: "Türkiye", category: "club",
      status: "not-in-ESPN-archive",
      reason: "The app has this extra competition, but candidate ESPN scoreboard slugs returned HTTP 400. Keep the existing provider fallback rather than inventing an ESPN mapping."
    }]
  };
}

async function ensureStatisticsSchema(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS mam_history_backfill_matches (source TEXT NOT NULL, fixture_id TEXT NOT NULL, league_id TEXT, league_name TEXT, country TEXT, kickoff TEXT, status TEXT, home_team_id TEXT, home_team TEXT, away_team_id TEXT, away_team TEXT, home_goals INTEGER, away_goals INTEGER, raw_json TEXT, statistics_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (source, fixture_id))"
  ).run();
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS mam_history_backfill_statistics (source TEXT NOT NULL, fixture_id TEXT NOT NULL, league_id TEXT NOT NULL, kickoff TEXT, outcome TEXT NOT NULL, statistics_json TEXT, raw_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (source, fixture_id))"
  ).run();
  const columns = await db.prepare("PRAGMA table_info(mam_history_backfill_matches)").all();
  if (!(columns.results || []).some(column => column.name === "statistics_json")) {
    try {
      await db.prepare("ALTER TABLE mam_history_backfill_matches ADD COLUMN statistics_json TEXT").run();
    } catch (error) {
      // Multiple isolated Preview runners may initialize the shared schema at once.
      // Ignore only the benign race where another runner added the column first.
      const refreshed = await db.prepare("PRAGMA table_info(mam_history_backfill_matches)").all();
      if (!(refreshed.results || []).some(column => column.name === "statistics_json")) throw error;
    }
  }
}

export async function buildHistoryStatisticsState(env, now = new Date()) {
  if (!env.DB || !env.MAM_KV) return { ok: false, status: "unavailable", reason: "D1 and KV bindings are required." };
  await ensureStatisticsSchema(env.DB);
  const [count, outcomes] = await Promise.all([
    env.DB.prepare(
      "SELECT COUNT(*) AS total FROM mam_history_backfill_matches WHERE source = 'ESPN' AND status IN ('FT','AET','PEN')"
    ).first(),
    env.DB.prepare(
      "SELECT COUNT(*) AS processed, SUM(CASE WHEN outcome = 'statistics-found' THEN 1 ELSE 0 END) AS statisticsFound, SUM(CASE WHEN outcome = 'partial-statistics' THEN 1 ELSE 0 END) AS partialStatistics, SUM(CASE WHEN outcome = 'no-statistics' THEN 1 ELSE 0 END) AS noStatistics FROM mam_history_backfill_statistics WHERE source = 'ESPN'"
    ).first()
  ]);
  const totalJobs = Number(count?.total || 0);
  const processedJobs = Number(outcomes?.processed || 0);
  const state = {
    version: 1,
    scope: "all-configured-competitions-statistics",
    createdAt: now.toISOString(),
    totalJobs,
    processedJobs,
    status: processedJobs >= totalJobs && totalJobs > 0
      ? (Number(outcomes?.partialStatistics || 0) + Number(outcomes?.noStatistics || 0) > 0 ? "complete-with-gaps" : "complete")
      : totalJobs ? "queued" : "waiting-for-fixtures",
    executionEnabled: false,
    retryJobs: [],
    deadLetters: [],
    statisticsFound: Number(outcomes?.statisticsFound || 0),
    partialStatistics: Number(outcomes?.partialStatistics || 0),
    noStatistics: Number(outcomes?.noStatistics || 0),
    note: "All configured ESPN competitions. Writes only to historical staging tables; live matches and live summary queues are untouched."
  };
  await env.MAM_KV.put(HISTORY_STATISTICS_KEY, JSON.stringify(state));
  return { ok: true, ...state };
}

export async function getHistoryStatisticsStatus(env) {
  if (!env.DB || !env.MAM_KV) return { ok: false, status: "unavailable" };
  const state = await env.MAM_KV.get(HISTORY_STATISTICS_KEY, "json");
  const coverage = await env.DB.prepare(
    "SELECT m.league_id AS leagueId, m.league_name AS league, COUNT(*) AS completedFixtures, SUM(CASE WHEN s.outcome = 'statistics-found' THEN 1 ELSE 0 END) AS statisticsFound, SUM(CASE WHEN s.outcome = 'partial-statistics' THEN 1 ELSE 0 END) AS partialStatistics, SUM(CASE WHEN s.outcome = 'no-statistics' THEN 1 ELSE 0 END) AS noStatistics, SUM(CASE WHEN s.fixture_id IS NULL THEN 1 ELSE 0 END) AS pending FROM mam_history_backfill_matches m LEFT JOIN mam_history_backfill_statistics s ON s.source = m.source AND s.fixture_id = m.fixture_id WHERE m.source = 'ESPN' AND m.status IN ('FT','AET','PEN') GROUP BY m.league_id, m.league_name ORDER BY m.league_name"
  ).all();
  const rows = Array.isArray(coverage?.results) ? coverage.results : [];
  return {
    ok: true,
    exists: Boolean(state),
    scope: "all-configured-competitions-statistics",
    status: state?.status || "not-created",
    executionEnabled: state?.executionEnabled === true,
    totalJobs: rows.reduce((sum, row) => sum + Number(row.completedFixtures || 0), 0),
    statisticsFound: rows.reduce((sum, row) => sum + Number(row.statisticsFound || 0), 0),
    partialStatistics: rows.reduce((sum, row) => sum + Number(row.partialStatistics || 0), 0),
    noStatistics: rows.reduce((sum, row) => sum + Number(row.noStatistics || 0), 0),
    pending: rows.reduce((sum, row) => sum + Number(row.pending || 0), 0),
    pendingRetries: Array.isArray(state?.retryJobs) ? state.retryJobs.length : 0,
    deadLetters: Array.isArray(state?.deadLetters) ? state.deadLetters.length : 0,
    byCompetition: rows.map(row => ({
      ...row,
      category: classifyHistoryCompetition(row.leagueId),
      completedFixtures: Number(row.completedFixtures || 0),
      statisticsFound: Number(row.statisticsFound || 0),
      partialStatistics: Number(row.partialStatistics || 0),
      noStatistics: Number(row.noStatistics || 0),
      pending: Number(row.pending || 0)
    }))
  };
}

export async function runHistoryStatisticsBatch(env, fetchImpl = fetch, options = {}) {
  if (env.HISTORY_STATISTICS_ENABLED !== "true" && options.previewAuthorized !== true) {
    return { ok: false, status: "disabled", reason: "Historical statistics processor is disabled." };
  }
  if (!env.DB || !env.MAM_KV) return { ok: false, status: "unavailable", reason: "D1 and KV bindings are required." };

  await ensureStatisticsSchema(env.DB);
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ${HISTORY_STATISTICS_LOCK_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0)`
  ).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO ${HISTORY_STATISTICS_LOCK_TABLE} (id, owner, lease_until) VALUES (1, '', 0)`
  ).run();

  const owner = crypto.randomUUID();
  const now = Date.now();
  const claim = await env.DB.prepare(
    `UPDATE ${HISTORY_STATISTICS_LOCK_TABLE} SET owner = ?, lease_until = ? WHERE id = 1 AND lease_until < ?`
  ).bind(owner, now + 180000, now).run();
  if (Number(claim?.meta?.changes || 0) !== 1) return { ok: false, status: "locked" };

  try {
    const state = await env.MAM_KV.get(HISTORY_STATISTICS_KEY, "json");
    if (!state) return { ok: false, status: "not-initialized" };
    if (state.executionEnabled !== true && options.previewAuthorized !== true) return { ok: false, status: "not-enabled" };

    const pendingRetries = Array.isArray(state.retryJobs) ? state.retryJobs : [];
    const deadLetters = Array.isArray(state.deadLetters) ? state.deadLetters : [];
    const readyRetries = pendingRetries.filter(job => Number(job.retryAfter || 0) <= now)
      .sort((a, b) => Number(a.retryAfter || 0) - Number(b.retryAfter || 0)).slice(0, 8);
    const retryIds = readyRetries.map(job => String(job.fixtureId || ""));
    const slots = Math.max(0, 8 - readyRetries.length);
    const retryFilter = retryIds.length ? " AND m.fixture_id NOT IN (" + retryIds.map(() => "?").join(",") + ")" : "";
    const result = slots ? await env.DB.prepare(
      "SELECT m.fixture_id AS fixtureId, m.league_id AS leagueId, m.kickoff, m.status FROM mam_history_backfill_matches m WHERE m.source = 'ESPN' AND m.status IN ('FT','AET','PEN') AND NOT EXISTS (SELECT 1 FROM mam_history_backfill_statistics s WHERE s.source = m.source AND s.fixture_id = m.fixture_id)" +
      retryFilter + " ORDER BY m.kickoff, m.league_id, m.fixture_id LIMIT ?"
    ).bind(...retryIds, slots).all() : { results: [] };
    const fresh = Array.isArray(result?.results) ? result.results : [];
    const fixtures = [
      ...readyRetries.map(job => ({ ...job, isRetry: true })),
      ...fresh.map(row => ({ ...row, isRetry: false, attempts: 0 }))
    ];
    if (!fixtures.length) {
      const [totalResult, processedResult] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) AS total FROM mam_history_backfill_matches WHERE source = 'ESPN' AND status IN ('FT','AET','PEN')").first(),
        env.DB.prepare("SELECT COUNT(*) AS total FROM mam_history_backfill_statistics WHERE source = 'ESPN'").first()
      ]);
      const totalJobs = Number(totalResult?.total || 0);
      const processedJobs = Number(processedResult?.total || 0);
      const hasRetry = pendingRetries.length > 0;
      const hasGaps = Number(state.partialStatistics || 0) + Number(state.noStatistics || 0) > 0;
      const status = hasRetry ? "retry-wait" : deadLetters.length ? "needs-review" :
        totalJobs === 0 ? "waiting-for-fixtures" :
        processedJobs >= totalJobs ? (hasGaps ? "complete-with-gaps" : "complete") : "running";
      const next = { ...state, totalJobs, processedJobs, status, lastRunAt: new Date().toISOString() };
      await env.MAM_KV.put(HISTORY_STATISTICS_KEY, JSON.stringify(next));
      return { ok: true, status, requested: 0, processedJobs, totalJobs,
        pendingRetries: pendingRetries.length, deadLetters: deadLetters.length };
    }

    const statements = [];
    const failures = [];
    const completedRetries = new Set();
    let statisticsFound = 0;
    let noStatistics = 0;
    let partialStatistics = 0;

    for (let i = 0; i < fixtures.length; i += 3) {
      await Promise.all(fixtures.slice(i, i + 3).map(async fixture => {
        const fixtureId = String(fixture.fixtureId || "");
        const match = /^espn-(.+)-(\d+)$/.exec(fixtureId);
        const league = HISTORY_BACKFILL_LEAGUES.find(item => String(item[0]) === String(fixture.leagueId));
        const isRetry = fixture.isRetry === true;
        const attempts = Number(fixture.attempts || 0);
        try {
          if (!match || !league || !match[1] || !match[2]) throw new Error("Fixture identity or configured competition is invalid");
          if (match[1] !== league[1]) throw new Error("Fixture ID league slug does not match archived league ID");
          const response = await fetchImpl("https://site.api.espn.com/apis/site/v2/sports/soccer/" + league[1] + "/summary?event=" + encodeURIComponent(match[2]), {
            headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000)
          });
          if (!response.ok) throw new Error("ESPN summary HTTP " + response.status);
          const payload = await response.json();
          const teams = Array.isArray(payload?.boxscore?.teams) ? payload.boxscore.teams : [];
          const home = teams.find(team => team.homeAway === "home");
          const away = teams.find(team => team.homeAway === "away");
          const valid = team => Boolean(team && (team.team?.displayName || team.team?.name) && Array.isArray(team.statistics));
          if (!valid(home) || !valid(away)) throw new Error("ESPN summary missing valid home/away statistics structure");
          const normalized = [home, away].map(team => ({
            homeAway: team.homeAway,
            team: team.team.displayName || team.team.name,
            statistics: team.statistics
          }));
          const homeHasStats = home.statistics.length > 0;
          const awayHasStats = away.statistics.length > 0;
          const completeStats = homeHasStats && awayHasStats;
          const partialStats = homeHasStats !== awayHasStats;
          const outcome = completeStats ? "statistics-found" : partialStats ? "partial-statistics" : "no-statistics";
          if (completeStats) statisticsFound++;
          else if (partialStats) partialStatistics++;
          else noStatistics++;
          const normalizedJson = JSON.stringify({
            teams: normalized,
            summaryAvailable: true,
            coverage: { home: homeHasStats, away: awayHasStats, complete: completeStats }
          });
          statements.push(env.DB.prepare(
            "INSERT INTO mam_history_backfill_statistics (source, fixture_id, league_id, kickoff, outcome, statistics_json, raw_json) VALUES ('ESPN', ?, ?, ?, ?, ?, ?) ON CONFLICT(source, fixture_id) DO UPDATE SET league_id=excluded.league_id, kickoff=excluded.kickoff, outcome=excluded.outcome, statistics_json=excluded.statistics_json, raw_json=excluded.raw_json, updated_at=CURRENT_TIMESTAMP"
          ).bind(fixtureId, String(fixture.leagueId), fixture.kickoff || null, outcome, normalizedJson, JSON.stringify(payload)));
          statements.push(env.DB.prepare(
            "UPDATE mam_history_backfill_matches SET statistics_json = ? WHERE source = 'ESPN' AND fixture_id = ? AND (statistics_json IS NULL OR statistics_json = '')"
          ).bind(normalizedJson, fixtureId));
          if (isRetry) completedRetries.add(fixtureId);
        } catch (error) {
          failures.push({
            fixtureId, kickoff: fixture.kickoff || null, leagueId: String(fixture.leagueId || ""),
            attempts: attempts + 1, reason: String(error?.message || error).slice(0, 180), isRetry
          });
        }
      }));
    }

    if (statements.length) {
      for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
    }
    const retryMap = new Map(pendingRetries.map(job => [job.fixtureId, job]));
    for (const id of completedRetries) retryMap.delete(id);
    const nextDeadLetters = [...deadLetters];
    for (const failure of failures) {
      if (failure.attempts >= 5) {
        retryMap.delete(failure.fixtureId);
        nextDeadLetters.push({ ...failure, exhaustedAt: new Date().toISOString() });
      } else {
        retryMap.set(failure.fixtureId, {
          fixtureId: failure.fixtureId, kickoff: failure.kickoff, leagueId: failure.leagueId,
          attempts: failure.attempts, retryAfter: now + Math.min(3600000, 60000 * (2 ** (failure.attempts - 1))),
          lastError: failure.reason
        });
      }
    }
    const retryJobs = [...retryMap.values()];
    const total = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM mam_history_backfill_matches WHERE source = 'ESPN' AND status IN ('FT','AET','PEN')"
    ).first();
    const done = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM mam_history_backfill_statistics WHERE source = 'ESPN'"
    ).first();
    const totalJobs = Number(total?.total || 0);
    const processedJobs = Number(done?.total || 0);
    const nextStatisticsFound = Number(state.statisticsFound || 0) + statisticsFound;
    const nextPartialStatistics = Number(state.partialStatistics || 0) + partialStatistics;
    const nextNoStatistics = Number(state.noStatistics || 0) + noStatistics;
    const hasCoverageGaps = nextPartialStatistics + nextNoStatistics > 0;
    const status = nextDeadLetters.length ? "needs-review" : retryJobs.length ? "retry-needed" :
      processedJobs >= totalJobs ? (hasCoverageGaps ? "complete-with-gaps" : "complete") : "running";
    const next = {
      ...state, totalJobs, processedJobs, status, retryJobs, deadLetters: nextDeadLetters,
      statisticsFound: nextStatisticsFound,
      partialStatistics: nextPartialStatistics,
      noStatistics: nextNoStatistics,
      lastRunAt: new Date().toISOString(),
      lastBatch: { requested: fixtures.length, fresh: fresh.length, retried: readyRetries.length,
        statisticsFound, partialStatistics, noStatistics, failures: failures.length, pendingRetries: retryJobs.length,
        deadLetters: nextDeadLetters.length }
    };
    await env.MAM_KV.put(HISTORY_STATISTICS_KEY, JSON.stringify(next));
    return { ok: true, status, requested: fixtures.length, fresh: fresh.length, processedJobs, totalJobs,
      statisticsFound, partialStatistics, noStatistics, failures, pendingRetries: retryJobs.length, deadLetters: nextDeadLetters.length };
  } finally {
    await env.DB.prepare(
      `UPDATE ${HISTORY_STATISTICS_LOCK_TABLE} SET owner = '', lease_until = 0 WHERE id = 1 AND owner = ?`
    ).bind(owner).run();
  }
}
