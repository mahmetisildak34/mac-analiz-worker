// Isolated staging health check. No production/preview bindings, cron, or upstream API.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/health") return new Response("Not found", {status:404});
    if (!env.TEST_WRITE_DB || env.PRODUCTION_READ_DB || env.PREVIEW_READ_DB || env.DB) {
      return Response.json({ok:false,error:"unsafe-or-missing-bindings"},{status:503});
    }
    if (env.STATISTICS_REPAIR_ENABLED !== "false" || env.STATISTICS_API_BACKFILL_ENABLED !== "false") {
      return Response.json({ok:false,error:"unsafe-feature-flags"},{status:503});
    }
    try {
      const table = await env.TEST_WRITE_DB.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type='table' AND name='mam_archive_test_matches'").first();
      return Response.json({ok:true,isolated:true,matchesTablePresent:table?.total===1});
    } catch {
      return Response.json({ok:false,error:"isolated-d1-read-failed"},{status:503});
    }
  }
};
