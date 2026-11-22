import { pathToFileURL } from "node:url";

const expectedLeagueIds = ["39", "203", "140", "78", "135", "61", "2", "3", "88", "94", "848"];

export function assessPriorityCoverage(report) {
  const leagues = report?.priorityLeagueCoverage;
  if (report?.ok !== true || !Array.isArray(leagues)) {
    throw new Error("Priority league audit response is missing a valid coverage report.");
  }
  const leagueIds = leagues.map(league => String(league?.leagueId));
  if (new Set(leagueIds).size !== leagueIds.length ||
      expectedLeagueIds.some(id => !leagueIds.includes(id))) {
    throw new Error("Priority league audit does not contain exactly one entry for each required league.");
  }
  return leagues.flatMap(league => {
    const {leagueId, leagueName, directoryVerified, teamsBelow10, missingUpcomingInD1, d1UpcomingNotInProvider} = league;
    if (typeof directoryVerified !== "boolean" || !Number.isSafeInteger(teamsBelow10) ||
        teamsBelow10 < 0 || !Array.isArray(missingUpcomingInD1) || !Array.isArray(d1UpcomingNotInProvider)) {
      throw new Error("Invalid coverage fields for league " + leagueId);
    }
    const missingUpcoming = missingUpcomingInD1.length;
    const extraUpcoming = d1UpcomingNotInProvider.length;
    return !directoryVerified || teamsBelow10 || missingUpcoming || extraUpcoming
      ? [{leagueId, leagueName, directoryVerified, teamsBelow10, missingUpcoming, extraUpcoming}]
      : [];
  });
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: {Accept: "application/json"},
    signal: AbortSignal.timeout(90000)
  });
  if (!response.ok) throw new Error("Priority league audit HTTP " + response.status);
  return response.json();
}

async function run() {
  const base = "https://odd-sunset-6c83.m-ahmetisildak34.workers.dev/api/archive/";
  const report = await getJson(base + "quality-check?limit=20000");
  const incomplete = assessPriorityCoverage(report);
  let syncStatus = null;
  try {
    syncStatus = await getJson(base + "sync-status");
  } catch (error) {
    console.warn("Could not read archive sync status:", error.message);
  }
  const {totalRecords, checked, truncated, invalidRecordCount, completedWithoutScoreCount, invalidScoreCount} = report;
  console.log("PRIORITY_LEAGUE_AUDIT=" + JSON.stringify({
    ranAt: new Date().toISOString(), totalRecords, checked, truncated, invalidRecordCount,
    completedWithoutScoreCount, invalidScoreCount, syncStatus,
    leagues: report.priorityLeagueCoverage, directoryErrors: report.priorityLeagueDirectoryErrors,
    incompleteLeagueCount: incomplete.length, incompleteLeagues: incomplete
  }, null, 2));
  for (const gap of incomplete) {
    console.error(`${gap.leagueName || gap.leagueId}: directory=${gap.directoryVerified}, teams below 10=${gap.teamsBelow10}, missing upcoming=${gap.missingUpcoming}, extra upcoming=${gap.extraUpcoming}`);
  }
  if (incomplete.length || truncated === true) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
