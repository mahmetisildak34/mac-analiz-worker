# Bulk statistics repair rollout — read-only inventory snapshot (2026-11-21)

## Current inventory (SELECT-only; no transfers performed)

- Production D1: `mac-analiz-arsiv`
- Preview D1: `mac-analiz-preview`
- Production matches: **13,372**
- Completed statuses (`FT`, `FINISHED`, `AET`, `PEN`): **9,897**
- Completed matches with NULL/empty statistics: **722**
- Completed matches with populated statistics: **9,175**
- Preview matches with non-empty statistics JSON: **2,554**
- Unique, reliable Preview candidates: **44**
- Unmatched: **678**
- Ambiguous: **0**
- Invalid/incomplete JSON among the 44: **0**
- Known team-ID conflicts among the 44: **0**
- Actual writes/transfers: **0**

See `STATISTICS_REPAIR_INVENTORY_2026-11-21.json` for the 44-row SHA-256 manifest and the seven same-day records.

## Why 715 became 722

The earlier 715 count used the historical cutoff `kickoff < '2026-11-21'`. The current full completed-match inventory has no such cutoff. Exactly seven additional completed matches have kickoff timestamps on 2026-11-21. The 715 historical count and the 722 all-completed count are therefore consistent; the difference is the seven same-day fixtures, not seven newly corrupted records.

## Matching policy

A transfer candidate must have all of the following:

1. Completed Production status and a truly empty statistics field.
2. Exact UTC calendar date.
3. Exact normalized, ordered home and away team names.
4. Exact home and away score.
5. Exactly one compatible Preview fixture.
6. No conflict between any known team IDs; `-1`, empty and `0` are treated as unknown, never as matching IDs.
7. When both fixture IDs have numeric suffixes, those suffixes must match.
8. Valid JSON containing exactly two ordered teams, both with non-empty statistics arrays, and team names matching the Production fixture.
9. SHA-256 computed over the exact Preview JSON bytes.

Equal statistics payloads do not collapse separate Preview fixtures. Multiple matching rows remain ambiguous and are rejected. Team aliases are deliberately conservative; unknown aliases are not guessed.

All 44 current candidates have at least one Production team ID marked `-1`; however, each has a compatible known ID on the other side, exact date/team/score identity, a matching numeric fixture-ID suffix, and a unique Preview row. No known-ID conflicts were observed.

## Hardened engine

`statistics-repair.js` now delegates to `statistics-repair-bulk.js`.

- Disabled unless `STATISTICS_REPAIR_ENABLED=true`.
- Read-only dry-run is the default even when the feature flag is enabled.
- Applying requires all three gates: `STATISTICS_REPAIR_APPLY_ENABLED=true`, `STATISTICS_REPAIR_BACKUP_REQUIRED=true`, and `STATISTICS_REPAIR_CONFIRMATION=APPLY_BULK_STATISTICS_REPAIR`.
- Preview binding is queried with SELECT only; the engine never writes to Preview.
- Production batch size defaults to 20 and is hard-capped at 25.
- Every row is revalidated against source, fixture ID, status, kickoff, team names, IDs, score, and original `updated_at` before an empty-only conditional update.
- A D1 batch transaction creates a per-match backup containing the previous statistics value, previous timestamp, exact candidate JSON, and SHA-256 before updating the row.
- Backup state is finalized only when the immediately preceding conditional update changed exactly one row.
- Rollback verifies the candidate SHA-256 and restores the prior value only while the current row still equals the exact applied payload.
- A lease prevents concurrent runs; a persistent keyset cursor supports repeatable small batches.
- Any write error fails the current batch immediately. The failing cursor is not advanced.
- No external football API requests are made.

## Test coverage added

`tests/statistics-repair-bulk.test.mjs` exercises a synthetic **722-row** candidate pool over batches capped at 25, with 44 Preview matches, 678 unmatched rows, a duplicate identical-payload ambiguity, existing populated statistics, unfinished rows, idempotent re-runs, backup/rollback, SHA validation, Preview read-only enforcement, invalid JSON, team-ID conflict, and injected write failure. The workflow now includes this test.

The GitHub Actions run for this new branch has not yet been executed; no CI result is claimed here.

## PR #69 review

Repository: `mahmetisildak34/mac-analiz-worker`  
PR: #69 — `feature/safe-statistics-repair-queue` → `main`  
Current state at review: open, draft, not merged, 18 changed files, 40 commits, no submitted reviews or review threads.

Gaps found in the original PR implementation and addressed in this separate hardening branch:
- Distinct Preview fixtures could be collapsed by identical JSON payload text.
- JSON validation accepted generic non-empty objects instead of requiring two ordered team-statistics arrays.
- The update did not bind all original match metadata and `updated_at` in the write guard.
- There was no per-row pre-update backup or SHA-guarded rollback.
- A row-level error could be logged and the batch continued instead of failing closed.
- The test suite covered 715 synthetic candidates, not the current 722-candidate pool.
- Batch size and explicit apply confirmation needed stronger hard limits.

PR #69 remains untouched and unmerged. This hardening work is on `feature/bulk-statistics-repair-hardening`.

## Deployment and data safety

No Production or Preview D1 write was performed for this task. No Worker was deployed, no Preview URL was opened, and PR #69 was not merged. Existing Cloudflare Preview deployment comments associated with PR #69 were not opened or used. DNS work remains separate.

The current 44-row manifest is a read-only snapshot, not authorization to write. Any future apply run must re-read and revalidate each target immediately before the conditional update.
