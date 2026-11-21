// Dedicated read-only Cloudflare binding smoke test. No cron, no writes, no upstream API.
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(url.pathname!=="/health") return new Response("Not found",{status:404});
    if(!env.PRODUCTION_READ_DB||!env.PREVIEW_READ_DB||!env.TEST_WRITE_DB) return Response.json({ok:false,error:"missing-bindings"},{status:503});
    try {
      const [production,preview,test]=await Promise.all([
        env.PRODUCTION_READ_DB.prepare("SELECT COUNT(*) AS total FROM matches").first(),
        env.PREVIEW_READ_DB.prepare("SELECT COUNT(*) AS total FROM mam_history_backfill_matches").first(),
        env.TEST_WRITE_DB.prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type=\'table\'").first()
      ]);
      return Response.json({ok:true,productionCount:production?.total,previewCount:preview?.total,testTables:test?.total,readOnly:true});
    } catch(e) {
      return Response.json({ok:false,error:"d1-read-failed"},{status:503});
    }
  }
};
