import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function read(name) {
  return JSON.parse(readFileSync(new URL("../" + name + "_2026-11-21.json", import.meta.url)));
}

test("unconfirmed metric and revision evidence stays out of the transfer manifest", () => {
  const review = read("STATISTICS_REPAIR_SAFARI_FOLLOWUP");
  const previous = read("STATISTICS_REPAIR_SAFARI_CONTINUATION");
  const transfer = read("STATISTICS_TRANSFER_REVALIDATION");
  assert.equal(review.partial_rows.length, 55);
  assert.deepEqual(review.partial_rows.map(row => row.missing), previous.partial_rows.map(row => row.missing));
  assert.equal(review.praviano.score_verified, false);
  assert.equal(review.local_candidates, transfer.data_eligible);
  for (const revision of review.transfer_revisions) {
    assert.equal(revision.live_apply_approved, false);
    assert(!transfer.rows.some(row => row.fixture_id === revision.fixture_id && row.candidate_data_eligible));
    assert(revision.checked_sources.every(result => result.status !== "current_revision_observed"));
  }
});
