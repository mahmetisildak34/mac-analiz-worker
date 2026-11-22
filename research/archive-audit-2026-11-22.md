# Verified archive audit — 2026-11-22

Source: production Cloudflare D1 `mac-analiz-arsiv`, SELECT-only. No data was modified. Query: `research/verified-espn-audit.sql`.

## Evidence
- Source-confirmed completed ESPN fixtures were checked for `post` state, match identifier suffix, two numeric provider scores, matching stored scores, home/away order and kickoff not in the future.
- The SQL query executed successfully on the live archive; every returned league had `future_dated = 0`.
- Selected counts: Serie A 864, La Liga 837, Premier League 796, Süper Lig 719, Primeira Liga 710, Ligue 1 683, Eredivisie 658, Bundesliga 635, Champions League 451, Europa League 450.
- These counts validate stored match results against the provider payload. They **do not** validate the accuracy of model predictions.
- Production schema inspection showed `matches`, `mam_api_quota_guard` and `_cf_KV` tables. No dedicated historical prediction table was present. A genuine v1.2/v1.3/v1.4 comparison needs archived, timestamped pre-match predictions from each model or a rigorously reconstructed point-in-time backtest. Do not claim a winner from final scores alone.
- Caution: this audit checks provider ID suffix and scores, not independent team identity fields; source-specific full team identity verification remains required.

## Safety and next acceptance gate
1. Acquire point-in-time, leakage-free pre-match features and model outputs for the same verified fixtures.
2. Run `research/run-paired-backtest.mjs` on an offline, evidence-backed JSON export.
3. Report paired sample counts, exclusions, per-league scores and chronological holdout; no model promotion without evidence.
4. Run GitHub Actions and verify all tests; keep Poisson v1.2 as default until proven otherwise.
