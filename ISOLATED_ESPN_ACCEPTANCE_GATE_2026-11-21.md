# Isolated ESPN acceptance gate (2026-11-21)

This checklist is **not** proof of a successful ESPN import. It documents the verified isolation and the remaining acceptance gates.

## Verified through live Cloudflare API

- Worker: `mam-statistics-readonly-staging`
- D1 binding: `TEST_WRITE_DB` -> `fb9b42cc-8d96-4911-b193-0983527ee593` (`mam-statistics-isolated-test`)
- No `PRODUCTION_READ_DB` or `PREVIEW_READ_DB` binding.
- The isolated database contains `mam_archive_test_matches`, `mam_archive_test_progress`, and `mam_archive_test_failures`.
- The three tables were created in the dashboard console. This **does not grant the connected Cloudflare API D1 Write permission**.

## Fail-closed import requirements

1. Confirm the Worker bindings again immediately before any test deployment.
2. Do not deploy or invoke a Worker that can access the production or preview databases.
3. Verify a live ESPN scoreboard response and provider limits; cap pilot at ten distinct provider-identified matches.
4. Require an ESPN event ID, kickoff, exact home/away side mapping, and source-specific `source + fixture_id` namespace.
5. Treat identity, final score, and statistics as three separate proofs. A scheduled/live match cannot have a verified final score. Empty or reconstructed statistics do not count as verified.
6. Persist only to `mam-statistics-isolated-test`, using the isolated `mam_archive_test_matches` table; preserve original provider JSON.
7. Verify idempotency with duplicate replay, resume using `mam_archive_test_progress`, and failures using `mam_archive_test_failures`.
8. If D1 API write is rejected (previously 7500), stop retries; do not substitute production/preview D1.

## Safe, read-only acceptance queries

Run these **only in the isolated database** after a pilot:

```sql
SELECT name FROM sqlite_master
 WHERE type = 'table' AND name IN
 ('mam_archive_test_matches','mam_archive_test_progress','mam_archive_test_failures')
 ORDER BY name;
SELECT COUNT(*) AS imported FROM mam_archive_test_matches;
SELECT source, fixture_id, kickoff, home_team, away_team,
       identity_verified, score_verified, statistics_verified
  FROM mam_archive_test_matches ORDER BY kickoff LIMIT 10;
SELECT COUNT(*) AS unverified_identity FROM mam_archive_test_matches
 WHERE identity_verified <> 1;
SELECT COUNT(*) AS queued_failures FROM mam_archive_test_failures;
SELECT job_id, status, attempts, cursor FROM mam_archive_test_progress;
```

## Current acceptance status

- Isolated schema: verified.
- Live ESPN requests in this acceptance run: **not yet executed**.
- Imported ESPN matches in this acceptance run: **0 confirmed**.
- Duplicate replay and resume against isolated D1: **not yet executed**.
- Cloudflare API D1 Write: **previously denied**; must be independently re-established before automated writes.
- No production deploy and no PR merge authorized.
