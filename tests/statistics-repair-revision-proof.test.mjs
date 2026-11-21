import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { recheckTransferRevision } from "../scripts/recheck-transfer-revision.mjs";

const { candidates } = JSON.parse(readFileSync(new URL("../STATISTICS_REPAIR_TRANSFER_ACCEPTANCE_2026-11-21.json", import.meta.url)));
const [candidate] = candidates;
const archive = { ...candidate.archived_provider_fields, statistics_json: null };
const now = "2026-11-22 00:00:00";

test("provider kickoff and revisionless snapshots cannot authorize a repair", () => {
  assert.equal(recheckTransferRevision([candidate.archived_provider_fields], candidate).status, "archive_statistics_state_missing");
  assert.equal(recheckTransferRevision([{ ...archive, raw_kickoff: now }], candidate).status, "archive_revision_missing");
  assert.equal(recheckTransferRevision([{ ...archive, updated_at: "not a timestamp" }], candidate).status, "archive_revision_missing");
  assert.deepEqual(recheckTransferRevision([{ ...archive, updated_at: now }], candidate), {
    fixture_id: candidate.fixture_id, live_apply_approved: false,
    status: "current_revision_observed", observed_updated_at: now,
  });
});

test("revision proof rejects a changed row, existing statistics or ambiguous identity", () => {
  const current = { ...archive, updated_at: now };
  assert.equal(recheckTransferRevision([current, current], candidate).status, "duplicate_archive_rows");
  assert.equal(recheckTransferRevision([{ ...current, home_goals: current.home_goals + 1 }], candidate).status, "archive_identity_changed");
  assert.equal(recheckTransferRevision([{ ...current, statistics_json: '{"teams":[]}' }], candidate).status, "archive_statistics_present");
});
