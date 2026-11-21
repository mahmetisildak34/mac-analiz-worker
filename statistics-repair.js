// Safe production-only backfill. No upstream API calls. Preview requires an explicit read-only binding.
const FINISHED = ["FT", "FINISHED", "AET", "PEN"];
const nonempty = x => typeof x === "string" && x.trim().length > 5 && x.trim() !== "{}" && x.trim() !== "[]";
const norm = x => String(x || "").toLocaleLowerCase("en").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
const date = x => String(x || "").slice(0,10);
function sameFixture(a,b) {
  return date(a.kickoff) === date(b.kickoff) &&
    norm(a.home_team) === norm(b.home_team) &&
    norm(a.away_team) === norm(b.away_team) &&
    a.home_goals != null && b.home_goals != null && Number(a.home_goals) === Number(b.home_goals) &&
    a.away_goals != null && b.away_goals != null && Number(a.away_goals) === Number(b.away_goals);
}
export async function ensureStatisticsRepairSchema(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS mam_statistics_repair_queue (source TEXT NOT NULL, fixture_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source,fixture_id))").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS mam_statistics_repair_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ran_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, scanned INTEGER NOT NULL, repaired INTEGER NOT NULL, unmatched INTEGER NOT NULL, errors INTEGER NOT NULL)").run();
}
export async function runStatisticsRepair(env) {
  if (String(env.STATISTICS_REPAIR_ENABLED || "") !== "true" || !env.DB) return {skipped:"disabled"};
  const db=env.DB;
  await ensureStatisticsRepairSchema(db);
  // A small bounded scan; the existing archive updater continues to populate matches.
  const targets=(await db.prepare("SELECT source,fixture_id,kickoff,home_team,away_team,home_goals,away_goals FROM matches WHERE status IN ('FT','FINISHED','AET','PEN') AND (statistics_json IS NULL OR length(trim(statistics_json))<=5) AND kickoff < datetime('now','-1 day') ORDER BY kickoff DESC LIMIT 25").all()).results || [];
  let repaired=0,unmatched=0,errors=0;
  for(const target of targets) {
    try {
      const prior=await db.prepare("SELECT state FROM mam_statistics_repair_queue WHERE source=? AND fixture_id=?").bind(target.source,target.fixture_id).first();
      if(prior?.state==="repaired") continue;
      // Same-date candidate scan is bounded and uses the existing kickoff index.
      const candidates=(await db.prepare("SELECT source,fixture_id,kickoff,home_team,away_team,home_goals,away_goals,statistics_json FROM matches WHERE kickoff >= ? AND kickoff < ? AND statistics_json IS NOT NULL AND length(trim(statistics_json))>5 LIMIT 150").bind(date(target.kickoff),new Date(Date.parse(date(target.kickoff)+"T00:00:00Z")+86400000).toISOString().slice(0,10)).all()).results || [];
      const matches=candidates.filter(x=>sameFixture(target,x)&&nonempty(x.statistics_json));
      if(matches.length===1) {
        // The WHERE guard is essential: never overwrite nonempty statistics.
        const result=await db.prepare("UPDATE matches SET statistics_json=?,updated_at=CURRENT_TIMESTAMP WHERE source=? AND fixture_id=? AND status IN ('FT','FINISHED','AET','PEN') AND (statistics_json IS NULL OR length(trim(statistics_json))<=5)").bind(matches[0].statistics_json,target.source,target.fixture_id).run();
        const changed=Number(result.meta?.changes||0);
        repaired+=changed;
        await db.prepare("INSERT INTO mam_statistics_repair_queue(source,fixture_id,state,updated_at) VALUES (?,?,'repaired',CURRENT_TIMESTAMP) ON CONFLICT(source,fixture_id) DO UPDATE SET state='repaired',updated_at=CURRENT_TIMESTAMP").bind(target.source,target.fixture_id).run();
      } else {
        unmatched++;
        // Do not mark unmatched permanently: source archives may grow.
        await db.prepare("INSERT INTO mam_statistics_repair_queue(source,fixture_id,state,updated_at) VALUES (?,?,'unmatched',CURRENT_TIMESTAMP) ON CONFLICT(source,fixture_id) DO UPDATE SET state='unmatched',updated_at=CURRENT_TIMESTAMP").bind(target.source,target.fixture_id).run();
      }
    }catch(error) {
      errors++;
      console.log("Statistics repair match failed",target.source,target.fixture_id,String(error?.message||error));
      await db.prepare("INSERT INTO mam_statistics_repair_queue(source,fixture_id,state,attempts,last_error,updated_at) VALUES (?,?,'error',1,?,CURRENT_TIMESTAMP) ON CONFLICT(source,fixture_id) DO UPDATE SET state='error',attempts=attempts+1,last_error=excluded.last_error,updated_at=CURRENT_TIMESTAMP").bind(target.source,target.fixture_id,String(error?.message||error).slice(0,500)).run().catch(()=>{});
    }
  }
  await db.prepare("INSERT INTO mam_statistics_repair_runs(scanned,repaired,unmatched,errors) VALUES (?,?,?,?)").bind(targets.length,repaired,unmatched,errors).run();
  return {scanned:targets.length,repaired,unmatched,errors,apiRequests:0};
}
