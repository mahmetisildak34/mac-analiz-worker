import {
  NATIONS_LEAGUE_STATISTICS_KEY,
  buildNationsLeagueStatisticsState,
  runNationsLeagueStatisticsBatch
} from "./history-backfill.js";

const RUNNER = "mam-nations-statistics-preview";
const SCOPE = "uefa-nations-league-statistics";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function assertPreview(env) {
  if (env.PREVIEW_ONLY !== "true" || env.ENVIRONMENT !== "preview") {
    throw new Error("Safety stop: statistics runner is Preview-only.");
  }
  if (env.HISTORY_STATISTICS_AUTORUN_ENABLED !== "true") {
    throw new Error("Automatic statistics collection is disabled.");
  }
  if (!env.DB || !env.MAM_KV) throw new Error("Preview D1 and KV bindings are required.");
}

async function runBatch(env, trigger) {
  assertPreview(env);
  let state = await env.MAM_KV.get(NATIONS_LEAGUE_STATISTICS_KEY, "json");
  if (!state) {
    const initialized = await buildNationsLeagueStatisticsState(env);
    if (!initialized.ok) return { ...initialized, scope: SCOPE, trigger };
    state = initialized;
  }

  // Refresh the target count so newly archived completed matches are picked up.
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM mam_history_backfill_matches WHERE league_id = '5' AND source = 'ESPN' AND status IN ('FT','AET','PEN')"
  ).first();
  state.totalJobs = Number(count?.total || 0);
  state.executionEnabled = true;
  state.updatedAt = new Date().toISOString();
  await env.MAM_KV.put(NATIONS_LEAGUE_STATISTICS_KEY, JSON.stringify(state));

  const result = await runNationsLeagueStatisticsBatch(env);
  return { ...result, scope: SCOPE, environment: "preview", trigger };
}

export default {
  async scheduled(controller, env) {
    try {
      const result = await runBatch(env, controller.cron || "scheduled");
      console.log("Nations League Preview statistics:", JSON.stringify(result));
    } catch (error) {
      console.error("Nations League Preview statistics safety/error:", error?.message || String(error));
    }
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/health" && url.pathname !== "/status" && url.pathname !== "/matches") return new Response("Not found", { status: 404 });
    try {
      assertPreview(env);
      if (url.pathname === "/matches") {
        const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
        const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
        const result = await env.DB.prepare(
          "SELECT m.fixture_id AS fixtureId, m.league_id AS leagueId, m.league_name AS leagueName, m.kickoff, m.status, m.home_team AS homeTeam, m.away_team AS awayTeam, m.home_goals AS homeGoals, m.away_goals AS awayGoals, m.statistics_json AS statisticsJson, s.outcome AS statisticsOutcome FROM mam_history_backfill_matches m LEFT JOIN mam_history_backfill_statistics s ON s.source = m.source AND s.fixture_id = m.fixture_id WHERE m.league_id = '5' AND m.source = 'ESPN' AND m.status IN ('FT','AET','PEN') ORDER BY m.kickoff DESC LIMIT ? OFFSET ?"
        ).bind(limit, offset).all();
        return json({
          ok: true, environment: "preview", scope: SCOPE,
          limit, offset, matches: result.results || [],
          note: "Read-only historical fixture archive with statistics joined by exact ESPN fixture ID."
        });
      }
      const state = await env.MAM_KV.get(NATIONS_LEAGUE_STATISTICS_KEY, "json");
      const count = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM mam_history_backfill_matches WHERE league_id = '5' AND source = 'ESPN' AND status IN ('FT','AET','PEN')"
      ).first();
      const total = Number(count?.total || 0);
      return json({
        ok: true, runner: RUNNER, environment: "preview", scope: SCOPE,
        schedule: "*/15 * * * *", enabled: true, exists: Boolean(state),
        status: state?.status || "waiting-for-fixtures",
        totalFixturesAvailable: total,
        processedJobs: Number(state?.cursor || 0),
        remainingJobs: Math.max(0, total - Number(state?.cursor || 0)),
        statisticsFound: Number(state?.statisticsFound || 0),
        noStatistics: Number(state?.noStatistics || 0),
        pendingRetries: Array.isArray(state?.retryJobs) ? state.retryJobs.length : 0,
        deadLetters: Array.isArray(state?.deadLetters) ? state.deadLetters.length : 0,
        lastRunAt: state?.lastRunAt || null,
        lastBatch: state?.lastBatch || null
      });
    } catch (error) {
      return json({ ok: false, status: "safety-stop", reason: error?.message || String(error) }, 503);
    }
  }
};
