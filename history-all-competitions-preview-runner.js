import {
  buildHistoryBackfillScopedState,
  getHistoryBackfillQueueConfig
} from "./history-statistics.js";
import { runHistoryBackfillBatch } from "./history-backfill.js";
import { buildHistoryStatisticsState, HISTORY_STATISTICS_KEY, runHistoryStatisticsBatch } from "./history-statistics.js";

const SCOPES = ["clubs", "national-teams"];

async function ensureEnabledQueue(env, scope) {
  const config = getHistoryBackfillQueueConfig(scope);
  let state = await env.MAM_KV.get(config.key, "json");
  if (!state) {
    state = buildHistoryBackfillScopedState(scope);
    await env.MAM_KV.put(config.key, JSON.stringify(state));
  }
  if (state.executionEnabled !== true) {
    state.executionEnabled = true;
    state.enabledAt = state.enabledAt || new Date().toISOString();
    await env.MAM_KV.put(config.key, JSON.stringify(state));
  }
  return { config, state };
}

async function ensureEnabledStatistics(env) {
  let state = await env.MAM_KV.get(HISTORY_STATISTICS_KEY, "json");
  if (!state) {
    const result = await buildHistoryStatisticsState(env);
    if (!result.ok) throw new Error("Unable to initialize statistics state: " + result.status);
    state = await env.MAM_KV.get(HISTORY_STATISTICS_KEY, "json");
  }
  if (state.executionEnabled !== true) {
    state.executionEnabled = true;
    state.enabledAt = state.enabledAt || new Date().toISOString();
    await env.MAM_KV.put(HISTORY_STATISTICS_KEY, JSON.stringify(state));
  }
  return state;
}

async function runPreviewCycle(env) {
  if (env.PREVIEW_ONLY !== "true" || env.ENVIRONMENT !== "preview") {
    throw new Error("Refusing to run: this scheduled worker is Preview-only.");
  }
  if (!env.DB || !env.MAM_KV) throw new Error("Preview D1 and KV bindings are required.");
  const fixtures = [];
  for (const scope of SCOPES) {
    const { config } = await ensureEnabledQueue(env, scope);
    const result = await runHistoryBackfillBatch(env, fetch, {
      stateKey: config.key,
      leagues: config.leagues,
      previewAuthorized: true
    });
    fixtures.push({ scope: config.scope, ...result });
  }
  await ensureEnabledStatistics(env);
  const statistics = await runHistoryStatisticsBatch(env);
  return {
    ok: true,
    environment: "preview",
    ranAt: new Date().toISOString(),
    fixtureQueues: fixtures,
    statistics
  };
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runPreviewCycle(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/status" && url.pathname !== "/") return new Response("Not found", { status: 404 });
    if (env.PREVIEW_ONLY !== "true" || env.ENVIRONMENT !== "preview") {
      return Response.json({ ok: false, error: "Preview-only worker guard failed." }, { status: 403 });
    }
    const queueStatus = [];
    for (const scope of SCOPES) {
      const config = getHistoryBackfillQueueConfig(scope);
      const state = await env.MAM_KV.get(config.key, "json");
      queueStatus.push({
        scope: config.scope,
        exists: Boolean(state),
        executionEnabled: state?.executionEnabled === true,
        status: state?.status || "not-created",
        totalJobs: Number(state?.totalJobs || 0),
        processedJobs: Number(state?.cursor || 0),
        retryJobs: Array.isArray(state?.retryJobs) ? state.retryJobs.length : 0,
        deadLetters: Array.isArray(state?.deadLetters) ? state.deadLetters.length : 0
      });
    }
    const statistics = await env.MAM_KV.get(HISTORY_STATISTICS_KEY, "json");
    return Response.json({
      ok: true,
      environment: "preview",
      schedule: "*/15 * * * *",
      fixtureQueues: queueStatus,
      statistics: {
        exists: Boolean(statistics),
        executionEnabled: statistics?.executionEnabled === true,
        status: statistics?.status || "not-created",
        processedJobs: Number(statistics?.processedJobs || 0),
        totalJobs: Number(statistics?.totalJobs || 0),
        retryJobs: Array.isArray(statistics?.retryJobs) ? statistics.retryJobs.length : 0,
        deadLetters: Array.isArray(statistics?.deadLetters) ? statistics.deadLetters.length : 0
      }
    });
  }
};
