import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const load = prefix => JSON.parse(readFileSync(new URL("../" + prefix + "_2026-11-21.json", import.meta.url)));
const review = load("STATISTICS_REPAIR_TRANSFER_ACCEPTANCE");
const transfer = load("STATISTICS_TRANSFER_REVALIDATION");
const verified = load("STATISTICS_REPAIR_VERIFIED");
const plan = load("STATISTICS_REPAIR_BATCH_PLAN");
const fixturePlan = plan.batches.flatMap(batch => batch.candidates);
const uefa = load("UEFA_KICKOFF_REPAIR_MANIFEST");

test("revalidated matches retain unique fingerprints and require archive revision", () => {
  assert.equal(review.candidates.length, 4);
  assert.equal(review.eligible_total, transfer.data_eligible);
  assert.equal(review.live_writes, 0);
  const existing = new Set(transfer.rows.map(row => row.fixture_id));
  for (const candidate of review.candidates) {
    const record = verified.fullMatches.find(r => r.source === candidate.source && r.fixture_id === candidate.fixture_id);
    assert(record);
    assert.equal(fixturePlan.filter(r => r.fixture_id === candidate.fixture_id).length, 1);
    assert(!existing.has(candidate.fixture_id));
    assert.equal(candidate.current_archive_updated_at, null);
    assert.equal(candidate.candidate_data_eligible, false);
    assert.equal(candidate.live_apply_approved, false);
    const hash = createHash("sha256").update(record.statistics_json).digest("hex");
    assert.equal(candidate.statistics_sha256, hash);
    assert.equal(candidate.source_sha256, record.source_payload_sha256);
  }
});

test("ambiguous score is excluded and all UEFA timestamps match original UTC fields", () => {
  const row = load("STATISTICS_REPAIR_BATCH_10_RESEARCH_STATUS").rows.find(r => r.fixture_id === "1613107");
  assert.equal(row.score, "3-1");
  assert.equal(row.score_verified, false);
  assert.equal(row.transfer_ready, false);
  assert.equal(review.uefa.reverified_exact_provider_rows, uefa.repairs.length);
  for (const { provider_record, new_kickoff, old_kickoff, live_apply_approved } of uefa.repairs) {
    assert.equal(Date.parse(provider_record.DateUtc), Date.parse(new_kickoff));
    assert.notEqual(Date.parse(old_kickoff), Date.parse(new_kickoff));
    assert.equal(live_apply_approved, false);
  }
});
