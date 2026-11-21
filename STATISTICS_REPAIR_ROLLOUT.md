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
