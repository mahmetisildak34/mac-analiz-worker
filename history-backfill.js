// Isolated historical fixture discovery queue.
// This module only creates and reports work items. It does not execute ESPN requests
// or write match rows; the live ESPN sync and statistics queues remain untouched.
export const HISTORY_BACKFILL_KEY = "mam:history-backfill-state:v1";
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
  ["6","caf.nations","Africa Cup of Nations","Africa"],
  ["15","fifa.cwc","FIFA Club World Cup","World"], ["307","ksa.1","Saudi Pro League","Saudi Arabia"]
];

export function buildHistoryBackfillState(now = new Date()) {
  const start = new Date(HISTORY_BACKFILL_START + "T12:00:00.000Z");
  const end = new Date(now);
  end.setUTCHours(12, 0, 0, 0);
  const jobs = [];
  for (const league of HISTORY_BACKFILL_LEAGUES) {
    for (const day = new Date(start); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
      jobs.push({ league, date: day.toISOString().slice(0, 10).replace(/-/g, ""), attempts: 0 });
    }
  }
  return {
    version: 1,
    createdAt: now.toISOString(),
    rangeStart: HISTORY_BACKFILL_START,
    rangeEnd: end.toISOString().slice(0, 10),
    seasonsRequested: ["2024/25", "2025/26", "2026/27"],
    leagueCount: HISTORY_BACKFILL_LEAGUES.length,
    jobs,
    cursor: 0,
    status: "queued",
    note: "Queue created only; execution is intentionally disabled until the isolated processor is reviewed and enabled."
  };
}
