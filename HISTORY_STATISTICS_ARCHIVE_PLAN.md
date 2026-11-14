# Historical match-statistics archive: separate phase

## Boundary

Historical fixture discovery writes only to `mam_history_backfill_matches`. It does not write to the live `matches` table and does not consume or reset the existing `mam:espn-summary-queue:v1` / `mam:espn-summary-done:v1` keys.

Statistics collection is a second phase. It must remain disabled until fixture staging has passed coverage and identity checks in isolated Preview.

## Evidence in the current Worker

The existing live ESPN summary collector requests:

`/apis/site/v2/sports/soccer/{leagueSlug}/summary?event={eventId}`

It reads `payload.boxscore.teams`, maps each team's `homeAway`, display name, and `statistics[]`, and writes a `{ teams, summaryAvailable: true }` JSON object to `matches.statistics_json`. This confirms the currently implemented ESPN response shape used by this project; it does not prove every historical match has a box score.

## Proposed isolated statistics stage

1. Select only staged fixtures with final status (`FT`, `AET`, `PEN`) and a valid ESPN league slug/event ID.
2. Use a dedicated KV state key, for example `mam:history-statistics-state:v1`, and a dedicated retry list. Do not reuse the live summary queue.
3. Fetch one ESPN summary per fixture, with a small concurrency cap and the same bounded lease pattern as fixture discovery.
4. Validate that `boxscore.teams` contains both home and away team entries and at least one non-empty `statistics[]` array before classifying a response as statistics-present.
5. Store the raw summary and parsed team statistics in a separate additive D1 table, for example `mam_history_backfill_statistics`, keyed by `(source, fixture_id)`. Keep the raw JSON so provider fields are not lost.
6. Distinguish outcomes:
   - `statistics-found`: validated team statistics stored.
   - `no-statistics`: valid summary response but no usable box score; retry on a long cooldown, then retain as explicitly unavailable.
   - `retryable-error`: timeout, network error, HTTP 429/5xx; exponential backoff.
   - `permanent-error`: invalid identity or unsupported response; retain for review.
7. Report coverage by league, season/date range, and statistic family (shots, shots on target, corners, possession, cards, etc.). Do not label a match fully covered merely because one statistic exists.
8. Only after Preview reconciliation should a separate, reviewed promotion step copy validated statistics into the live archive. Promotion must never overwrite a non-empty, usable statistics record.

## Important limitation

ESPN may not expose a box score for every competition, season, or fixture. Missing provider data must remain “unavailable”, not be fabricated or filled with zero. If ESPN lacks coverage, evaluate a second provider separately and match records only with exact team identity plus a narrow kickoff-time window.

## Activation gates

- Fixture discovery queue tests pass.
- Preview-only fixture coverage audit is reviewed.
- Statistics endpoint response samples are verified across representative leagues.
- Statistics-stage tests cover empty box scores, malformed responses, 429/5xx retries, idempotent upserts, and preservation of existing data.
- No production flag, cron, live-table write, or promotion is enabled by this design document.
