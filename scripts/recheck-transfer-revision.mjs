import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const fields = [
  "source", "fixture_id", "home_team", "away_team", "home_team_id", "away_team_id",
  "home_goals", "away_goals", "league_id", "status",
];
const supportedRevision = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;

export function recheckTransferRevision(archiveRows, candidate) {
  const expected = candidate.archived_provider_fields;
  const result = { fixture_id: candidate.fixture_id, live_apply_approved: false };
  const matches = archiveRows.filter(row => row.source === candidate.source && String(row.fixture_id) === candidate.fixture_id);
  if (matches.length !== 1) return { ...result, status: matches.length ? "duplicate_archive_rows" : "archive_row_missing" };
  const [row] = matches;
  const kickoff = Date.parse(row.kickoff);
  if (!Number.isFinite(kickoff) || kickoff !== Date.parse(expected.kickoff) ||
      fields.some(field => row[field] == null || String(row[field]) !== String(expected[field]))) {
    return { ...result, status: "archive_identity_changed" };
  }
  if (!Object.hasOwn(row, "statistics_json")) return { ...result, status: "archive_statistics_state_missing" };
  if (row.statistics_json !== null && !["", "{}", "[]", "null"].includes(String(row.statistics_json).trim())) {
    return { ...result, status: "archive_statistics_present" };
  }
  const revision = row.updated_at;
  if (typeof revision !== "string" || !supportedRevision.test(revision) || !Number.isFinite(Date.parse(revision))) {
    return { ...result, status: "archive_revision_missing" };
  }
  return { ...result, status: "current_revision_observed", observed_updated_at: revision };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const read = file => JSON.parse(readFileSync(file, "utf8"));
  const rows = read(process.argv[2]);
  const { candidates } = read(process.argv[3]);
  console.log(JSON.stringify(candidates.map(candidate => recheckTransferRevision(rows, candidate)), null, 2));
}
