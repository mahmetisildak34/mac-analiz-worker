import {
  NATIONS_LEAGUE_BACKFILL_KEY,
  NATIONS_LEAGUE_BACKFILL_LEAGUE,
  runHistoryBackfillBatch
} from "./history-backfill.js";

const PREVIEW_HOST = "mam-nations-history-preview";
const SCOPE = "uefa-nations-league";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function assertPreviewEnvironment(env) {
  if (env.PREVIEW_ONLY !== "true" || env.ENVIRONMENT !== "preview") {
    throw new Error("Safety stop: this runner is restricted to the isolated Preview environment.");
  }
  if (!env.DB || !env.MAM_KV) throw new Error("Preview D1 and KV bindings are required.");
  if (env.HISTORY_BACKFILL_AUTORUN_ENABLED !== "true") {
    throw new Error("Automatic historical processing is disabled by feature flag.");
  }
}

async function runOneBoundedBatch(env, trigger) {
  assertPreviewEnvironment(env);
  const state = await env.MAM_KV.get(NATIONS_LEAGUE_BACKFILL_KEY, "json");
  if (!state) return { ok: false, status: "not-initialized", scope: SCOPE, trigger };
  if (state.status === "complete" && !(state.retryJobs || []).length) {
    return { ok: true, status: "complete", scope: SCOPE, processedJobs: state.cursor, totalJobs: state.totalJobs, trigger };
  }

  // The dedicated Preview runner is the sole authority that enables this isolated queue.
  if (state.executionEnabled !== true) {
    state.executionEnabled = true;
    state.enabledAt = state.enabledAt || new Date().toISOString();
    state.enabledBy = PREVIEW_HOST;
    await env.MAM_KV.put(NATIONS_LEAGUE_BACKFILL_KEY, JSON.stringify(state));
  }

  const result = await runHistoryBackfillBatch(env, fetch, {
    stateKey: NATIONS_LEAGUE_BACKFILL_KEY,
    leagues: [NATIONS_LEAGUE_BACKFILL_LEAGUE],
    previewAuthorized: true
  });
  return { ...result, scope: SCOPE, environment: "preview", trigger };
}

export default {
  async scheduled(controller, env, ctx) {
    try {
      const result = await runOneBoundedBatch(env, controller.cron || "scheduled");
      console.log("Nations League Preview backfill:", JSON.stringify(result));
    } catch (error) {
      console.error("Nations League Preview backfill safety/error:", error?.message || String(error));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/health" && url.pathname !== "/status") return new Response("Not found", { status: 404 });
    try {
      assertPreviewEnvironment(env);
      const state = await env.MAM_KV.get(NATIONS_LEAGUE_BACKFILL_KEY, "json");
      return json({
        ok: true,
        runner: PREVIEW_HOST,
        environment: "preview",
        scope: SCOPE,
        schedule: "*/15 * * * *",
        enabled: true,
        exists: Boolean(state),
        status: state?.status || "not-initialized",
        processedJobs: Number(state?.cursor || 0),
        totalJobs: Number(state?.totalJobs || 0),
        remainingJobs: Math.max(0, Number(state?.totalJobs || 0) - Number(state?.cursor || 0)),
        savedMatchesLastBatch: Number(state?.lastBatch?.saved || 0),
        lastRunAt: state?.lastRunAt || null,
        pendingRetries: Array.isArray(state?.retryJobs) ? state.retryJobs.length : 0,
        deadLetters: Array.isArray(state?.deadLetters) ? state.deadLetters.length : 0
      });
    } catch (error) {
      return json({ ok: false, status: "safety-stop", reason: error?.message || String(error) }, 503);
    }
  }
};
