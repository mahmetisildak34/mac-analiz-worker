// Fail-closed bulk historical statistics repair.
// Read-only planning by default. Applying requires three explicit environment gates.
// Preview D1 is SELECT-only. Production writes are per-match, conditional and backed up.
const FINISHED = ["FT", "FINISHED", "AET", "PEN"];
const EMPTY_SQL = "(statistics_json IS NULL OR length(trim(statistics_json)) = 0 OR trim(statistics_json) IN ('{}','[]','null'))";
const MAX_BATCH = 25;
const DEFAULT_BATCH = 25;

const TEAM_ALIASES = Object.freeze({
  "man utd":"manchester united", "man united":"manchester united", "manchester utd":"manchester united",
  "man city":"manchester city", "inter":"inter milan", "ath madrid":"atletico madrid",
  "atletico":"atletico madrid", "psg":"paris saint germain", "sporting lisbon":"sporting cp",
  "istanbul basaksehir":"basaksehir", "istanbul bb":"basaksehir", "basaksehir fk":"basaksehir",
  "erzurum bb":"erzurumspor", "amed sfk":"amedspor"
});
const LEAGUE_ALIASES = Object.freeze({
  "uefa champions league":"uefa champions league", "champions league uefa":"uefa champions league",
  "uefa europa league":"uefa europa league", "europa league uefa":"uefa europa league",
  "uefa conference league":"uefa conference league", "uefa europa conference league":"uefa conference league",
  "coupe de france":"coupe de france", "french cup":"coupe de france", "france cup":"coupe de france",
  "uefa european u21 championship qualification":"uefa u21 championship qualification",
  "uefa u21 championship qualification":"uefa u21 championship qualification",
  "international friendly":"international friendly", "international friendlies":"international friendly",
  "copa del rey":"copa del rey", "spanish cup":"copa del rey",
  "esp 2":"segunda division spain", "segunda division":"segunda division spain", "laliga 2":"segunda division spain"
});
export function normalizeTeam(value) {
  const normalized = String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/&/g, " and ")
    .replace(/\b(football club|fc|afc|cf|sc|sk|fk)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return TEAM_ALIASES[normalized] || normalized;
}
export function normalizeLeague(value) {
  const normalized = String(value || "").normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return LEAGUE_ALIASES[normalized] || normalized;
}
export function sameCompetition(a, b) {
  if (!a || !b) return true;
  const aId = String(a.league_id ?? "").trim(), bId = String(b.league_id ?? "").trim();
  if (aId && bId && aId === bId) return true;
  const aLeague = normalizeLeague(a.league_name), bLeague = normalizeLeague(b.league_name);
  if (!aLeague || !bLeague) return true;
  const aCountry = String(a.country || "").trim().toLowerCase();
  const bCountry = String(b.country || "").trim().toLowerCase();
  const countryCompatible = !aCountry || !bCountry || aCountry === bCountry;
  return countryCompatible && aLeague === bLeague;
}
export function classifyStatisticsPayload(raw) {
  let parsed;
  try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return "invalid"; }
  const teams = Array.isArray(parsed?.teams) ? parsed.teams :
    Array.isArray(parsed?.response) ? parsed.response : null;
  if (!teams || teams.length !== 2 || !teams.every(t => Array.isArray(t?.statistics) && t.statistics.length)) return "invalid";
  const aliases = [
    ["totalshots","total shots","shots"], ["shotsontarget","shots on target","shots on goal"],
    ["possessionpct","ball possession","possession"], ["woncorners","corner kicks","corners"],
    ["foulscommitted","fouls committed","fouls"], ["yellowcards","yellow cards"], ["redcards","red cards"]
  ].map(group => group.map(n=>n.replace(/[^a-z0-9]+/g,"")));
  const complete = teams.every(team => {
    const names = new Set(team.statistics.map(s => String(s.name || s.type || s.displayName || "").toLowerCase().replace(/[^a-z0-9]+/g,"")));
    return aliases.every(group => group.some(name => names.has(name)));
  });
  return complete ? "full" : "partial";
}

export function utcDay(value) {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}
function knownId(value) {
  const s = String(value ?? "").trim();
  return s !== "" && s !== "-1" && s !== "0";
}
function idsCompatible(a, b) {
  return !knownId(a) || !knownId(b) || String(a) === String(b);
}
function numericSuffix(value) {
  return String(value || "").match(/(\d+)$/)?.[1] || "";
}
function sameTuple(a, b) {
  return utcDay(a.kickoff) !== "" &&
    utcDay(a.kickoff) === utcDay(b.kickoff) &&
    normalizeTeam(a.home_team) !== "" &&
    normalizeTeam(a.home_team) === normalizeTeam(b.home_team) &&
    normalizeTeam(a.away_team) !== "" &&
    normalizeTeam(a.away_team) === normalizeTeam(b.away_team) &&
    a.home_goals != null && b.home_goals != null &&
    Number(a.home_goals) === Number(b.home_goals) &&
    a.away_goals != null && b.away_goals != null &&
    Number(a.away_goals) === Number(b.away_goals);
}
export function sameFixture(a, b) {
  return sameTuple(a, b) &&
    idsCompatible(a.home_team_id, b.home_team_id) &&
    idsCompatible(a.away_team_id, b.away_team_id);
}
function parseUsableStatistics(raw, target) {
  if (typeof raw !== "string" || raw.trim().length <= 5 ||
      ["{}", "[]", "null"].includes(raw.trim())) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const teams = Array.isArray(parsed?.teams) ? parsed.teams :
    Array.isArray(parsed?.response) ? parsed.response : null;
  if (!teams || teams.length !== 2) return null;
  const name = team => typeof team?.team === "string" ? team.team :
    typeof team?.team?.name === "string" ? team.team.name : "";
  if (!teams.every(team => Array.isArray(team?.statistics) && team.statistics.length > 0)) return null;
  if (normalizeTeam(name(teams[0])) !== normalizeTeam(target.home_team) ||
      normalizeTeam(name(teams[1])) !== normalizeTeam(target.away_team)) return null;
  return parsed;
}
async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function nextDay(day) {
  return new Date(Date.parse(day + "T00:00:00.000Z") + 86400000).toISOString().slice(0, 10);
}

// Finds exactly one safe Preview record. Equal JSON payloads do NOT collapse
// distinct source rows: uniqueness is about fixture identity, not payload text.
export async function planStatisticsRepairTarget(previewDb, target) {
  if (!previewDb || typeof previewDb.prepare !== "function") return { state: "missing-preview-binding" };
  const date = utcDay(target.kickoff);
  if (!date) return { state: "invalid-target-date" };
  const sql = "SELECT * FROM mam_history_backfill_matches WHERE date(kickoff)=? AND statistics_json IS NOT NULL AND length(trim(statistics_json))>5 AND trim(statistics_json) NOT IN ('{}','[]','null') ORDER BY kickoff,source,fixture_id LIMIT 501";
  const result = await previewDb.prepare(sql).bind(date).all();
  const rows = result.results || [];
  if (rows.length > 500) return { state: "ambiguous", reason: "same-day-preview-window-over-500" };
  const tupleMatches = rows.filter(row => sameTuple(target, row) && sameCompetition(target, row));
  const compatible = tupleMatches.filter(row =>
    idsCompatible(target.home_team_id, row.home_team_id) &&
    idsCompatible(target.away_team_id, row.away_team_id));
  const targetSuffix = numericSuffix(target.fixture_id);
  const suffixMatches = targetSuffix ? compatible.filter(row => numericSuffix(row.fixture_id) === targetSuffix) : [];
  const selected = suffixMatches.length === 1 ? suffixMatches :
    compatible.length === 1 && (!targetSuffix || !numericSuffix(compatible[0].fixture_id)) ? compatible : [];
  if (selected.length !== 1) {
    if (tupleMatches.length > 1 || compatible.length > 1) return { state: "ambiguous", reason: "multiple-preview-fixtures" };
    if (tupleMatches.length === 1 && compatible.length === 0) return { state: "rejected", reason: "known-team-id-conflict" };
    if (compatible.length === 1 && targetSuffix && numericSuffix(compatible[0].fixture_id) &&
        numericSuffix(compatible[0].fixture_id) !== targetSuffix) return { state: "rejected", reason: "fixture-id-suffix-conflict" };
    return { state: "unmatched" };
  }
  const preview = selected[0];
  const parsed = parseUsableStatistics(preview.statistics_json, target);
  if (!parsed) return { state: "rejected", reason: "invalid-or-incomplete-statistics-json" };
  const digest = await sha256(preview.statistics_json);
  return {
    state: "ready",
    source: preview.source,
    fixture_id: preview.fixture_id,
    statistics_json: preview.statistics_json,
    statistics_sha256: digest,
    statistics_length: preview.statistics_json.length,
    teams: parsed.teams.length
  };
}

async function ensureSchema(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS mam_statistics_repair_queue (source TEXT NOT NULL, fixture_id TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, candidate_sha256 TEXT, last_error TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source,fixture_id))"),
    db.prepare("CREATE TABLE IF NOT EXISTS mam_statistics_repair_backup (source TEXT NOT NULL, fixture_id TEXT NOT NULL, candidate_sha256 TEXT NOT NULL, previous_statistics_json TEXT, previous_updated_at TEXT, candidate_statistics_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'prepared', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(source,fixture_id,candidate_sha256))"),
    db.prepare("CREATE TABLE IF NOT EXISTS mam_statistics_repair_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ran_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, scanned INTEGER NOT NULL, repaired INTEGER NOT NULL, unmatched INTEGER NOT NULL, ambiguous INTEGER NOT NULL, errors INTEGER NOT NULL, dry_run INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS mam_statistics_repair_control (id INTEGER PRIMARY KEY CHECK(id=1), cursor_kickoff TEXT NOT NULL DEFAULT '', cursor_source TEXT NOT NULL DEFAULT '', cursor_fixture_id TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0, owner TEXT NOT NULL DEFAULT '')"),
    db.prepare("INSERT OR IGNORE INTO mam_statistics_repair_control(id) VALUES (1)")
  ]);
}

async function applyCandidate(db, target, plan) {
  if (typeof db.batch !== "function") throw new Error("D1 batch transaction unavailable; fail closed");
  const insertBackup = db.prepare(
    "INSERT OR IGNORE INTO mam_statistics_repair_backup(source,fixture_id,candidate_sha256,previous_statistics_json,previous_updated_at,candidate_statistics_json,state) " +
    "SELECT ?,?,?,statistics_json,updated_at,?,'prepared' FROM matches WHERE source=? AND fixture_id=? " +
    "AND upper(trim(status)) IN ('FT','FINISHED','AET','PEN') AND " + EMPTY_SQL +
    " AND kickoff=? AND home_team=? AND away_team=? AND home_goals=? AND away_goals=? AND home_team_id IS ? AND away_team_id IS ? AND updated_at=?"
  ).bind(target.source,target.fixture_id,plan.statistics_sha256,plan.statistics_json,target.source,target.fixture_id,
    target.kickoff,target.home_team,target.away_team,target.home_goals,target.away_goals,
    target.home_team_id,target.away_team_id,target.updated_at);
  const update = db.prepare(
    "UPDATE matches SET statistics_json=?,updated_at=CURRENT_TIMESTAMP WHERE source=? AND fixture_id=? " +
    "AND upper(trim(status)) IN ('FT','FINISHED','AET','PEN') AND " + EMPTY_SQL +
    " AND kickoff=? AND home_team=? AND away_team=? AND home_goals=? AND away_goals=? AND home_team_id IS ? AND away_team_id IS ? AND updated_at=? " +
    "AND EXISTS (SELECT 1 FROM mam_statistics_repair_backup b WHERE b.source=? AND b.fixture_id=? AND b.candidate_sha256=? AND b.state='prepared')"
  ).bind(plan.statistics_json,target.source,target.fixture_id,target.kickoff,target.home_team,target.away_team,
    target.home_goals,target.away_goals,target.home_team_id,target.away_team_id,target.updated_at,
    target.source,target.fixture_id,plan.statistics_sha256);
  const finalize = db.prepare(
    "UPDATE mam_statistics_repair_backup SET state=CASE WHEN changes()=1 AND EXISTS (SELECT 1 FROM matches m WHERE m.source=? AND m.fixture_id=? AND m.statistics_json=?) THEN 'applied' ELSE 'stale' END " +
    "WHERE source=? AND fixture_id=? AND candidate_sha256=? AND state='prepared'"
  ).bind(target.source,target.fixture_id,plan.statistics_json,target.source,target.fixture_id,plan.statistics_sha256);
  const results = await db.batch([insertBackup,update,finalize]);
  const changed = Number(results?.[1]?.meta?.changes || 0);
  if (changed !== 1) throw new Error("conditional-update-did-not-change-exactly-one-row");
  const backup = await db.prepare("SELECT state FROM mam_statistics_repair_backup WHERE source=? AND fixture_id=? AND candidate_sha256=?").bind(target.source,target.fixture_id,plan.statistics_sha256).first();
  if (backup?.state !== "applied") throw new Error("backup-finalization-failed");
  return { changed, sha256: plan.statistics_sha256 };
}

export async function rollbackStatisticsRepair(db, source, fixtureId, candidateSha256) {
  if (!db || typeof db.batch !== "function") throw new Error("D1 batch transaction unavailable; fail closed");
  const backup = await db.prepare("SELECT * FROM mam_statistics_repair_backup WHERE source=? AND fixture_id=? AND candidate_sha256=? AND state='applied'").bind(source,fixtureId,candidateSha256).first();
  if (!backup) return { rolledBack: false, reason: "applied-backup-not-found" };
  if (await sha256(backup.candidate_statistics_json) !== candidateSha256) throw new Error("backup-candidate-sha256-mismatch");
  const results = await db.batch([
    db.prepare("UPDATE matches SET statistics_json=?,updated_at=? WHERE source=? AND fixture_id=? AND statistics_json=?")
      .bind(backup.previous_statistics_json,backup.previous_updated_at,source,fixtureId,backup.candidate_statistics_json),
    db.prepare("UPDATE mam_statistics_repair_backup SET state='rolled_back' WHERE source=? AND fixture_id=? AND candidate_sha256=? AND state='applied' AND changes()=1 AND EXISTS (SELECT 1 FROM matches WHERE source=? AND fixture_id=? AND statistics_json IS ?)")
      .bind(source,fixtureId,candidateSha256,source,fixtureId,backup.previous_statistics_json)
  ]);
  if (Number(results?.[0]?.meta?.changes || 0) !== 1) return { rolledBack: false, reason: "current-row-changed-or-not-matching-applied-payload" };
  return { rolledBack: true, source, fixtureId, candidateSha256 };
}

function batchSize(env) {
  const requested = Number(env.STATISTICS_REPAIR_BATCH_SIZE || DEFAULT_BATCH);
  if (!Number.isSafeInteger(requested) || requested < 1) return DEFAULT_BATCH;
  return Math.min(MAX_BATCH, requested);
}

export async function runStatisticsRepair(env) {
  if (String(env?.STATISTICS_REPAIR_ENABLED || "") !== "true" || !env?.DB) return { skipped: "disabled" };
  if (!env.PREVIEW_DB) return { skipped: "preview-binding-required" };
  const apply = String(env.STATISTICS_REPAIR_APPLY_ENABLED || "") === "true" &&
    String(env.STATISTICS_REPAIR_BACKUP_REQUIRED || "") === "true" &&
    String(env.STATISTICS_REPAIR_CONFIRMATION || "") === "APPLY_BULK_STATISTICS_REPAIR";
  const db = env.DB;
  const limit = batchSize(env);
  const cutoff = new Date().toISOString();
  if (apply) await ensureSchema(db);
  let owner = "";
  if (apply) {
    owner = crypto.randomUUID();
    const now = Date.now();
    const lock = await db.prepare("UPDATE mam_statistics_repair_control SET owner=?,lease_until=? WHERE id=1 AND lease_until<? RETURNING id")
      .bind(owner,now+120000,now).first();
    if (!lock) return { skipped: "locked" };
  }
  let scanned=0,repaired=0,unmatched=0,ambiguous=0,errors=0;
  const ready=[];
  try {
    const cursor = apply ? await db.prepare("SELECT cursor_kickoff,cursor_source,cursor_fixture_id FROM mam_statistics_repair_control WHERE id=1").first() :
      {cursor_kickoff:"",cursor_source:"",cursor_fixture_id:""};
    const query = "SELECT source,fixture_id,kickoff,status,home_team,away_team,home_team_id,away_team_id,home_goals,away_goals,updated_at FROM matches " +
      "WHERE upper(trim(status)) IN ('FT','FINISHED','AET','PEN') AND " + EMPTY_SQL + " AND kickoff<? " +
      "AND (kickoff>? OR (kickoff=? AND (source>? OR (source=? AND fixture_id>?)))) " +
      "ORDER BY kickoff,source,fixture_id LIMIT ?";
    let targets=(await db.prepare(query).bind(cutoff,cursor.cursor_kickoff,cursor.cursor_kickoff,cursor.cursor_source,cursor.cursor_source,cursor.cursor_fixture_id,limit).all()).results||[];
    if (!targets.length && apply && cursor.cursor_kickoff) {
      await db.prepare("UPDATE mam_statistics_repair_control SET cursor_kickoff='',cursor_source='',cursor_fixture_id='' WHERE id=1 AND owner=?").bind(owner).run();
      targets=(await db.prepare(query).bind(cutoff,"","","","", "",limit).all()).results||[];
    }
    for (const target of targets) {
      scanned++;
      const plan = await planStatisticsRepairTarget(env.PREVIEW_DB,target);
      if (plan.state === "ready") {
        ready.push({source:target.source,fixture_id:target.fixture_id,preview_source:plan.source,preview_fixture_id:plan.fixture_id,statistics_sha256:plan.statistics_sha256,statistics_length:plan.statistics_length});
        if (apply) {
          try {
            await applyCandidate(db,target,plan);
            repaired++;
            await db.prepare("INSERT INTO mam_statistics_repair_queue(source,fixture_id,state,attempts,candidate_sha256,updated_at) VALUES (?,?,'repaired',1,?,CURRENT_TIMESTAMP) ON CONFLICT(source,fixture_id) DO UPDATE SET state='repaired',attempts=attempts+1,candidate_sha256=excluded.candidate_sha256,last_error=NULL,updated_at=CURRENT_TIMESTAMP")
              .bind(target.source,target.fixture_id,plan.statistics_sha256).run();
          } catch (error) {
            errors++;
            await db.prepare("INSERT INTO mam_statistics_repair_queue(source,fixture_id,state,attempts,candidate_sha256,last_error,updated_at) VALUES (?,?,'error',1,?,?,CURRENT_TIMESTAMP) ON CONFLICT(source,fixture_id) DO UPDATE SET state='error',attempts=attempts+1,last_error=excluded.last_error,updated_at=CURRENT_TIMESTAMP")
              .bind(target.source,target.fixture_id,plan.statistics_sha256,String(error?.message||error).slice(0,500)).run();
            throw error;
          }
        }
      } else if (plan.state === "ambiguous") {
        ambiguous++;
        if (apply) await db.prepare("INSERT INTO mam_statistics_repair_queue(source,fixture_id,state,attempts,last_error,updated_at) VALUES (?,?,'ambiguous',1,?,CURRENT_TIMESTAMP) ON CONFLICT(source,fixture_id) DO UPDATE SET state='ambiguous',attempts=attempts+1,last_error=excluded.last_error,updated_at=CURRENT_TIMESTAMP").bind(target.source,target.fixture_id,plan.reason||"ambiguous").run();
      } else {
        unmatched++;
        if (apply) await db.prepare("INSERT INTO mam_statistics_repair_queue(source,fixture_id,state,attempts,last_error,updated_at) VALUES (?,?,'unmatched',1,?,CURRENT_TIMESTAMP) ON CONFLICT(source,fixture_id) DO UPDATE SET state='unmatched',attempts=attempts+1,last_error=excluded.last_error,updated_at=CURRENT_TIMESTAMP").bind(target.source,target.fixture_id,plan.reason||plan.state).run();
      }
      if (apply) await db.prepare("UPDATE mam_statistics_repair_control SET cursor_kickoff=?,cursor_source=?,cursor_fixture_id=? WHERE id=1 AND owner=?")
        .bind(target.kickoff,target.source,target.fixture_id,owner).run();
    }
    if (apply) await db.prepare("INSERT INTO mam_statistics_repair_runs(scanned,repaired,unmatched,ambiguous,errors,dry_run) VALUES (?,?,?,?,?,0)")
      .bind(scanned,repaired,unmatched,ambiguous,errors).run();
    return {dryRun:!apply,scanned,repaired,unmatched,ambiguous,errors,apiRequests:0,batchLimit:limit,ready};
  } finally {
    if (apply) await db.prepare("UPDATE mam_statistics_repair_control SET lease_until=0,owner='' WHERE id=1 AND owner=?").bind(owner).run();
  }
}
