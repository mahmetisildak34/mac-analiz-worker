// Disabled-by-default API backfill policy. This module intentionally has no fetch().
export function apiBackfillDecision(env, quota) {
  if (String(env?.STATISTICS_API_BACKFILL_ENABLED||"")!=="true") return {allowed:false,reason:"feature-disabled"};
  if (String(env?.API_FOOTBALL_QUOTA_VERIFIED||"")!=="true") return {allowed:false,reason:"provider-quota-unverified"};
  const configured=Number(env?.API_FOOTBALL_DAILY_LIMIT);
  const verified=Number(env?.API_FOOTBALL_VERIFIED_LIMIT);
  const used=Number(quota?.used);
  if (!Number.isSafeInteger(configured)||configured<=0||!Number.isSafeInteger(verified)||verified<=0||configured>verified)
    return {allowed:false,reason:"invalid-verified-budget"};
  if (!Number.isSafeInteger(used)||used<0) return {allowed:false,reason:"missing-shared-quota-state"};
  const reserve=Math.max(10,Math.ceil(verified*0.2));
  const repairBudget=Math.min(5,Math.max(0,configured-used-reserve));
  if (repairBudget<=0) return {allowed:false,reason:"budget-exhausted"};
  return {allowed:true,remainingBatch:repairBudget,reason:"eligible-only-after-shared-atomic-reservation"};
}
export function classifyApiCandidate(match) {
  if (!match || !["FT","FINISHED","AET","PEN"].includes(match.status)) return "not-finished";
  if (typeof match.fixture_id!=="string" || !/^[0-9]+$/.test(match.fixture_id)) return "no-provider-fixture-id";
  if (match.statistics_json && String(match.statistics_json).trim().length>5) return "already-populated";
  return "eligible-for-verified-provider-check";
}
