# Bulk statistics repair rollout — read-only inventory snapshot (2026-11-21)

## Current inventory (SELECT-only; no transfers performed)

- Production D1: `mac-analiz-arsiv`
- Preview D1: `mac-analiz-preview`
- Production matches: **13,372**
- Completed statuses (`FT`, `FINISHED`, `AET`, `PEN`): **9,897**
- Completed matches with NULL/empty statistics: **722**
- Completed matches with populated statistics: **9,175**
- Preview matches with non-empty statistics JSON: **2,554** (confirmed in both Preview history tables; zero orphan rows in either direction)
- Preview JSON parse-valid: **2,554 / 2,554**
- Exactly two team objects: **2,554 / 2,554**
- Both teams have non-empty statistics arrays: **2,540 / 2,554**
- Statistics team names agree with match metadata: **2,532 / 2,554**
- Duplicate `(source, fixture_id)` groups: **0**
- Unique, reliable Preview candidates: **44**
- Unmatched: **678**
- Ambiguous: **0**
- Invalid/incomplete JSON among the 44: **0**
- Known team-ID conflicts among the 44: **0**
- Actual writes/transfers: **0**

See `STATISTICS_REPAIR_INVENTORY_2026-11-21.json` for the 44-row SHA-256 manifest and the seven same-day records. An earlier Preview count of 2,548 was superseded by the subsequent full SELECT scan, which found 2,554 in both the match and statistics tables; this reinforces the need for a fresh read immediately before any future apply.

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

GitHub Actions runs **#1 and #2** on this branch completed successfully (run IDs `44891662595` and `44891814251`; latest tested commit `f953787bf9850fe700a85eda5396b8839e87fa2e`). Syntax checks, both focused integration tests, and the full 722-row SQLite suite passed. The synthetic stress suite applied 43 rows, rejected one ambiguous duplicate, left 678 unmatched, and verified rollback, SHA-tamper rejection, stale-snapshot rejection, idempotence, Preview read-only enforcement and fail-stop behavior.

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


## 678-candidate provider research and code preparation (2026-11-21)

The existing 44-row manifest remains unchanged. A separate candidate inventory was created from a fresh Production SELECT and excludes those exact 44 (source, fixture_id) pairs:

- STATISTICS_REPAIR_CANDIDATE_INVENTORY_2026-11-21.json: 678 rows.
- Provider groups: API-Football 300; ESPN 227; UEFA fixture-download 61; SportScore 67; Football-Data UEFA 23.
- All 300 app/numeric API-Football rows pass the inventory's raw JSON identity proof: fixture ID, ordered home/away team IDs, and API-Sports league-logo namespace.
- ESPN's 227 rows include 101 ESPN, 45 espn, and 81 ESPN event IDs stored under app.

A separate evidence manifest is maintained at STATISTICS_REPAIR_VERIFIED_2026-11-21.json. It currently contains one newly verified full-statistics candidate: Troyes–Le Havre AC (ESPN, espn-fra.1-401876395, 2026-11-20). The event's two ordered competitor IDs, event ID, and score agree with Production. Both sides have total shots, shots on target, possession, corners, fouls, and yellow/red card counts; card counts are derived from the match's actual ESPN event details. The manifest stores the exact normalized statistics JSON, its SHA-256, and the source raw_json SHA-256. This is evidence only; no D1 write was performed.

**Correction to the initial exploration note:** the earlier 8-full/3-partial ESPN examples were already-populated statistics_json rows and therefore were outside the 678 missing-statistics pool. They must not be counted as newly recovered candidates. The Troyes–Le Havre record is the one source-embedded statistics payload verified within the 678 candidates so far.

The remaining research queue is 677 candidates. STATISTICS_REPAIR_BATCH_PLAN_2026-11-21.json splits them into 29 provider-priority batches, each containing at most 25 fixtures:

- API-Football: 300 (12 batches)
- ESPN: 226 (10 batches)
- UEFA: 61 (3 batches)
- SportScore: 67 (3 batches)
- Football-Data: 23 (1 batch)

### Code changes prepared

- API-Football candidate classification accepts app rows only when raw_json proves numeric fixture ID, ordered team IDs, and API-Sports league logo. The gated cron SELECT now includes these candidates; the existing three independent quota gates remain mandatory.
- API-Football statistics responses are normalized to home/away order by team ID. Persistence re-reads and revalidates the fixture and uses an explicit-empty-only conditional UPDATE.
- ESPN discovery includes ESPN, espn, and app rows whose fixture ID is in the ESPN event namespace. Queue keys, cursors, and pending writes are source-aware.
- ESPN summary payloads are checked against the target fixture's home/away team IDs or normalized names before acceptance.
- ESPN summary and cross-source enrichment writes now target the exact source/fixture pair and only explicit empty placeholders. Existing partial or populated JSON is not overwritten.
- Cross-source matching supports explicit team and competition aliases, preserves country/league context, rejects reversed sides and near-tied ambiguous candidates, and writes in batches of 25.
- statistics-repair-bulk.js defaults to 25 and hard-caps at 25. Provider-priority batch planning is deterministic and rejects duplicate candidate identities.
- New tests cover app-import API identity, API quota gates, ESPN source aliases, side validation, league/team aliases, full/partial classification, manifest SHA-256, and the 677-row batch plan.

### Execution gates still closed

- API-Football quota/account status has not been verified. No API-Football request was sent.
- No ESPN, UEFA, SportScore, or Football-Data bulk downloads were started as part of this preparation.
- No Production or Preview D1 write, Worker deployment, automatic transfer, GitHub Actions transfer, or PR #69 merge was performed.
- The 44-row original manifest was not modified.
