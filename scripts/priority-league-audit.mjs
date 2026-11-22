const priorityIds = new Set(["39", "203", "140", "78", "135", "61", "2", "3", "88", "94", "848"]);

export function evaluatePriorityLeagueCoverage(report) {
  const errors = [];
  const incomplete = [];
  if (report?.ok !== true || !Array.isArray(report.priorityLeagueCoverage) ||
      !Array.isArray(report.priorityLeagueDirectoryErrors)) {
    return { errors: ["Invalid archive coverage payload"], incomplete };
  }
  if (report.truncated !== false) errors.push("Archive coverage is truncated or truncation status is missing");
  if (report.priorityLeagueDirectoryErrors.length) errors.push("One or more ESPN directory or scoreboard requests failed");
  const seen = new Set();
  for (const league of report.priorityLeagueCoverage) {
    const id = String(league?.leagueId ?? "");
    if (!priorityIds.has(id) || seen.has(id)) {
      errors.push("Unexpected or duplicate priority league: " + id);
      continue;
    }
    seen.add(id);
    if (typeof league.directoryVerified !== "boolean" ||
        !Number.isSafeInteger(league.teamsBelow10) || league.teamsBelow10 < 0 ||
        !Array.isArray(league.missingUpcomingInD1) || !Array.isArray(league.d1UpcomingNotInProvider)) {
      errors.push("Invalid priority league coverage: " + id);
      continue;
    }
    if (!league.directoryVerified || league.teamsBelow10 > 0 ||
        league.missingUpcomingInD1.length || league.d1UpcomingNotInProvider.length) {
      incomplete.push(id);
    }
  }
  for (const id of priorityIds) {
    if (!seen.has(id)) errors.push("Missing priority league: " + id);
  }
  return { errors, incomplete };
}
