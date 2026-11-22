# Poisson v1.2 / v1.3 / v1.4 paired research comparison

**Run date:** 2026-11-22  
**Dataset:** pinned public OpenFootball `football.json` revision `e6744429ee395bc86f247348c6184bb08d4eb361`  
**Competitions:** Süper Lig, Premier League, La Liga, Bundesliga, Serie A, Ligue 1  
**Evaluation:** same-fixture paired chronological test; full-time and half-time evaluated separately  
**Default model:** Poisson v1.2 remains unchanged

## Important scope and evidence limits

This is a reproducible offline backtest from public OpenFootball results, not a replay of archived production predictions and not a fresh ESPN/Cloudflare D1 extraction. The importer's identity/score flags mean the source rows passed the importer schema checks; they are not independent provider cross-verification. Model probabilities are reconstructed from only earlier matches in the same archive. No production Worker, D1 database, API-Football quota, or provider endpoint was used.

The comparison workflow is deliberately fail-closed: it requires exactly 889 common test fixtures for each period, checks the same sample across all three models, and does not promote a model. Calibration reliability validation is **false** for both periods, so no confidence tier or default-model change is justified.

## Aggregate results

Lower Brier score and log loss are better. Accuracy is shown for context and is not the sole selection criterion.

| Period | Model | Paired matches | Brier | Log loss | Accuracy |
|---|---:|---:|---:|---:|---:|
| Full time | v1.2 | 889 | 0.623704 | 1.050174 | 0.503937 |
| Full time | v1.3 | 889 | 0.609782 | 1.021638 | 0.500562 |
| Full time | v1.4 | 889 | 0.600068 | 1.004716 | 0.517435 |
| Half time | v1.2 | 889 | 0.689829 | 1.275484 | 0.398200 |
| Half time | v1.3 | 889 | 0.670609 | 1.119035 | 0.386952 |
| Half time | v1.4 | 889 | 0.654555 | 1.084690 | 0.401575 |

Aggregate scores favour v1.4 on this dataset, but this does not establish production superiority. The reliability gate remains disabled.

## Per-league full-time results

| League | Matches | v1.2 Brier / log loss | v1.3 Brier / log loss | v1.4 Brier / log loss |
|---|---:|---:|---:|---:|
| Süper Lig | 25 | 0.5975 / 0.9840 | 0.5928 / 0.9865 | 0.5641 / 0.9539 |
| Premier League | 177 | 0.6768 / 1.1174 | 0.6571 / 1.0846 | 0.6455 / 1.0674 |
| La Liga | 203 | 0.6278 / 1.0528 | 0.6080 / 1.0183 | 0.5921 / 0.9934 |
| Bundesliga | 167 | 0.6089 / 1.0412 | 0.6001 / 1.0163 | 0.5895 / 0.9929 |
| Serie A | 196 | 0.5759 / 0.9772 | 0.5691 / 0.9612 | 0.5720 / 0.9643 |
| Ligue 1 | 146 | 0.6348 / 1.0733 | 0.6206 / 1.0373 | 0.6057 / 1.0122 |

## Per-league half-time results

| League | Matches | v1.2 Brier / log loss | v1.3 Brier / log loss | v1.4 Brier / log loss |
|---|---:|---:|---:|---:|
| Süper Lig | 25 | 0.7386 / 1.1876 | 0.7045 / 1.1380 | 0.6877 / 1.1202 |
| Premier League | 177 | 0.6602 / 1.1208 | 0.6489 / 1.0859 | 0.6397 / 1.0641 |
| La Liga | 203 | 0.7175 / 1.2070 | 0.6875 / 1.1394 | 0.6532 / 1.0817 |
| Bundesliga | 167 | 0.6744 / 1.3441 | 0.6565 / 1.1010 | 0.6454 / 1.0726 |
| Serie A | 196 | 0.6964 / 1.5140 | 0.6783 / 1.1406 | 0.6693 / 1.1072 |
| Ligue 1 | 146 | 0.6961 / 1.1597 | 0.6793 / 1.1226 | 0.6651 / 1.0975 |

## Interpretation and next acceptance gate

- v1.4 has the lowest aggregate Brier and log loss on this paired archive sample in both periods.
- v1.4 does not win every per-league full-time comparison: Serie A v1.3 is slightly better on both Brier and log loss.
- The Süper Lig holdout is only 25 fixtures per period, too small to support a confident league-specific ranking.
- Reliability validation failed; the low/medium/high sample-quality bins did not meet the required monotonic held-out log-loss condition.
- Keep v1.2 as the production default. Keep v1.3 and v1.4 research-only until a separately sourced, timestamped pre-match forecast archive and independent source identity/score evidence pass the same leakage-free paired evaluation.

## Reproduction

GitHub Actions workflow: `.github/workflows/poisson-comparison.yml`  
It pins the OpenFootball revision, imports 12 league-season JSON files with SHA-256 digests, runs the offline comparison, asserts 889 common fixtures per period and uploads the complete JSON report as a workflow artifact.

No production deployment, D1 write, or API-Football request is part of this workflow.
