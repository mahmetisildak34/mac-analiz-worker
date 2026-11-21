// Historical statistics repair: existing D1 records only. No network calls or API credentials.
const FINISHED = ["FT","FINISHED","AET","PEN"];
const emptySql = "(statistics_json IS NULL OR length(trim(statistics_json))<=5 OR trim(statistics_json) IN ('{}','[]'))";
export const normalizeTeam = value => String(value||"").toLowerCase().replace(/ı/g,"i").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
const day = value => String(value||"").slice(0,10);
const validStats = value => typeof value==="string" && value.trim().length>5 && !["{}","[]","null"].includes(value.trim()) && (()=>{try {const parsed=JSON.parse(value);return parsed!==null && typeof parsed==="object" && Object.keys(parsed).length>0;}catch{return false;}})();
export function sameFixture(a,b) {
  for (const side of ["home","away"]) {
    const left=String(a[side+"_team_id"]??""),right=String(b[side+"_team_id"]??"");
    if(left&&right&&left!=="-1"&&right!=="-1"&&left!==right) return false;
  }
  return day(a.kickoff)===day(b.kickoff) &&
    normalizeTeam(a.home_team)===normalizeTeam(b.home_team) &&
    normalizeTeam(a.away_team)===normalizeTeam(b.away_team) &&
    a.home_goals!=null && b.home_goals!=null && Number(a.home_goals)===Number(b.home_goals) &&
    a.away_goals!=null && b.away_goals!=null && Number(a.away_goals)===Number(b.away_goals);
}
export async function ensureStatisticsRepairSchema(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS mam_statistics_repair_queue (source TEXT NOT NULL, fixture_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source,fixture_id))").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS mam_statistics_repair_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ran_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, scanned INTEGER NOT NULL, repaired INTEGER NOT NULL, unmatched INTEGER NOT NULL, errors INTEGER NOT NULL)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS mam_statistics_repair_control (id INTEGER PRIMARY KEY CHECK(id=1), cursor_kickoff TEXT NOT NULL DEFAULT '', cursor_source TEXT NOT NULL DEFAULT '', cursor_fixture_id TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0, owner TEXT NOT NULL DEFAULT '')").run();
  await db.prepare("INSERT OR IGNORE INTO mam_statistics_repair_control(id) VALUES (1)").run();
}
async function findCandidates(db, table, target) {
  const from=day(target.kickoff);
  const until=new Date(Date.parse(from+"T00:00:00Z")+86400000).toISOString().slice(0,10);
  const sql=table==="matches"
    ? "SELECT source,fixture_id,kickoff,home_team,away_team,home_team_id,away_team_id,home_goals,away_goals,statistics_json FROM matches WHERE kickoff>=? AND kickoff<? AND statistics_json IS NOT NULL AND length(trim(statistics_json))>5 LIMIT 500"
    : "SELECT source,fixture_id,kickoff,home_team,away_team,home_team_id,away_team_id,home_goals,away_goals,statistics_json FROM mam_history_backfill_matches WHERE kickoff>=? AND kickoff<? AND statistics_json IS NOT NULL AND length(trim(statistics_json))>5 LIMIT 500";
  const result=await db.prepare(sql).bind(from,until).all();
  // Never assume a truncated result is exhaustive: ambiguous or incomplete matches must not be copied.
  if((result.results||[]).length>=500) return {truncated:true,rows:[]};
  return {truncated:false,rows:(result.results||[]).filter(x=>validStats(x.statistics_json)&&sameFixture(target,x))};
}
export async function runStatisticsRepair(env) {
  if(String(env.STATISTICS_REPAIR_ENABLED||"")!=="true" || !env.DB) return {skipped:"disabled"};
  const db=env.DB;
  await ensureStatisticsRepairSchema(db);
  const owner=crypto.randomUUID(),now=Date.now();
  const lock=await db.prepare("UPDATE mam_statistics_repair_control SET owner=?,lease_until=? WHERE id=1 AND lease_until<? RETURNING id").bind(owner,now+120000,now).first();
  if(!lock) return {skipped:"locked"};
  let scanned=0,repaired=0,unmatched=0,errors=0;
  try {
    const control=await db.prepare("SELECT cursor_kickoff,cursor_source,cursor_fixture_id FROM mam_statistics_repair_control WHERE id=1").first();
    const query="SELECT source,fixture_id,kickoff,home_team,away_team,home_team_id,away_team_id,home_goals,away_goals FROM matches WHERE status IN ('FT','FINISHED','AET','PEN') AND "+emptySql+" AND kickoff < ? AND (kickoff>? OR (kickoff=? AND (source>? OR (source=? AND fixture_id>?)))) ORDER BY kickoff,source,fixture_id LIMIT 20";
    const cutoff=new Date(Date.now()-86400000).toISOString();
    const args=[cutoff,control.cursor_kickoff,control.cursor_kickoff,control.cursor_source,control.cursor_source,control.cursor_fixture_id];
    let targets=(await db.prepare(query).bind(...args).all()).results||[];
    if(!targets.length && control.cursor_kickoff) {
      await db.prepare("UPDATE mam_statistics_repair_control SET cursor_kickoff='',cursor_source='',cursor_fixture_id='' WHERE id=1 AND owner=?").bind(owner).run();
      targets=(await db.prepare(query).bind(cutoff,"","","","","").all()).results||[];
    }
    for(const target of targets) {
      scanned++;
      try {
        const production=await findCandidates(db,"matches",target);
        const preview=env.PREVIEW_DB ? await findCandidates(env.PREVIEW_DB,"preview",target) : {truncated:false,rows:[]};
        const candidates=[...production.rows,...preview.rows].filter(x=>!(x.source===target.source&&x.fixture_id===target.fixture_id));
        const distinct=new Map(candidates.map(x=>[x.statistics_json,x.statistics_json]));
        const unambiguous=!production.truncated&&!preview.truncated&&distinct.size===1;
        if(unambiguous) {
          const stats=[...distinct.values()][0];
          const result=await db.prepare("UPDATE matches SET statistics_json=?,updated_at=CURRENT_TIMESTAMP WHERE source=? AND fixture_id=? AND status IN ('FT','FINISHED','AET','PEN') AND "+emptySql).bind(stats,target.source,target.fixture_id).run();
          repaired+=Number(result.meta?.changes||0);
        } else unmatched++;
        await db.prepare("INSERT INTO mam_statistics_repair_queue(source,fixture_id,state,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(source,fixture_id) DO UPDATE SET state=excluded.state,updated_at=CURRENT_TIMESTAMP").bind(target.source,target.fixture_id,unambiguous?"repaired":"unmatched").run();
      }catch(error) {
        errors++;
        const message=String(error?.message||error).slice(0,500);
        console.log("Statistics repair failed",target.source,target.fixture_id,message);
        await db.prepare("INSERT INTO mam_statistics_repair_queue(source,fixture_id,state,attempts,last_error,updated_at) VALUES (?,?,'error',1,?,CURRENT_TIMESTAMP) ON CONFLICT(source,fixture_id) DO UPDATE SET state='error',attempts=attempts+1,last_error=excluded.last_error,updated_at=CURRENT_TIMESTAMP").bind(target.source,target.fixture_id,message).run().catch(()=>{});
      }
      await db.prepare("UPDATE mam_statistics_repair_control SET cursor_kickoff=?,cursor_source=?,cursor_fixture_id=? WHERE id=1 AND owner=?").bind(target.kickoff,target.source,target.fixture_id,owner).run();
    }
    await db.prepare("INSERT INTO mam_statistics_repair_runs(scanned,repaired,unmatched,errors) VALUES (?,?,?,?)").bind(scanned,repaired,unmatched,errors).run();
    return {scanned,repaired,unmatched,errors,apiRequests:0,previewEnabled:!!env.PREVIEW_DB};
  } finally {
    await db.prepare("UPDATE mam_statistics_repair_control SET lease_until=0,owner='' WHERE id=1 AND owner=?").bind(owner).run();
  }
}
