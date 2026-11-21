# Statistics repair rollout (not deployed)

This branch is deliberately **disabled by default**. Do not merge until CI and staging validation pass.

## Behavior
- Production D1 `DB` is the only writable database. Optional `PREVIEW_DB` must bind the preview database; the module only executes SELECT against it.
- It matches finished fixtures by exact UTC date, normalized home/away names and both scores; ambiguous matches are not copied.
- A bounded, persistent keyset cursor scans the backlog in repeated cron runs, with a 120-second D1 lease to avoid overlapping work.
- All updates use an atomic empty-statistics guard; already populated statistics are never overwritten.
- An error log and queue state are persisted in new additive tables. The cursor wraps to recheck unmatched and failed records.
- No outbound API calls exist in the module. No API-Football daily allowance is consumed.

## Before production approval
1. Validate CI including the SQLite-backed D1 integration test, plus a preview-only deployment test.
2. Review the staged `PREVIEW_DB` binding in wrangler.jsonc (preview database ID `704a5c24-491f-455f-b62a-23752083f085`). It is configured in the development branch only and has not been deployed. The repair module uses this binding only for SELECT.
3. Confirm the GitHub Actions Cloudflare token can deploy and that D1 schema migrations are permitted. ChatGPT's D1 write failure does not establish the Actions token's permissions.
4. Explicitly set `STATISTICS_REPAIR_ENABLED=true` only after a successful preview test and final production authorization.
5. Confirm queue growth, 715-candidate coverage, zero overwrite, errors, and remaining backlog through D1 read-only queries.

## Limitations
- This is a **zero-external-API** repair process, not an API backfill downloader. Matches without suitable existing statistics remain unmatched.
- The matcher is conservative and may miss aliases or cross-midnight fixtures.
- A same-day candidate set of 500+ is treated as ambiguous; never blindly copy.
- Daily provider quota is unverified, so API backfill remains disabled.


## Final pre-production audit (2026-11-21)
- Cloudflare production Worker `odd-sunset-6c83` currently exposes only `DB` (production D1); `PREVIEW_DB` is **not deployed**. A real two-binding Worker test cannot be claimed without deploying a separate isolated test Worker. Do not deploy to production for this test.
- D1 `mam_api_quota_guard` has observable local counts, but it does **not** establish the provider subscription's real daily quota, nor prove all Workers use the same counter. API download must remain disabled.
- New `statistics-api-cron.js` is called by scheduled Worker only behind `STATISTICS_API_BACKFILL_ENABLED=true`, `API_FOOTBALL_QUOTA_VERIFIED=true`, and `STATISTICS_API_SHARED_GUARD_AUDITED=true`. Default behavior is inert.
- API concurrency across Workers, durable retries over many days, and provider budget exhaustion need isolated staging tests with a mock provider and shared D1; they are not proven by the unit tests.

## First-wave 44-match rollout (requires final production approval)
1. Recompute the 44 exact date/home/away/score matches from read-only production and preview D1 snapshots, and require unique match plus compatible known team IDs.
2. Require JSON parse success, exactly two correctly ordered teams and meaningful nonempty statistics arrays. Record a proposed change manifest with source, fixture ID and SHA-256 of candidate statistics.
3. Dry-run the manifest with zero writes; manually review ambiguous or incomplete IDs and exclude them.
4. After approval, run a bounded first wave (e.g. 5 matches) using the empty-only conditional UPDATE, with a pre-update snapshot and audit log. Stop if any mismatch, existing nonempty statistics, or unexpected number of affected rows.
5. Validate results and only then continue remaining matches in bounded batches. No external API requests are necessary for this phase.

## Production blockers
- An isolated real Cloudflare Worker integration environment with both D1 bindings has not been validated.
- Actual API-Football account quota and shared counter across all API-calling Workers are unverified.
- The API cron queue uses a single eligible fixture per tick; multi-worker concurrency, rate-limit atomicity, and long-lived retry recovery require more testing.
- The existing repair module writes new tables to its DB when enabled; never enable it against production before the final approval.
