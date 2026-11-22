# Offline Poisson comparison

Run with Node 22 and a local checkout of openfootball/football.json containing revision
`e6744429ee395bc86f247348c6184bb08d4eb361`.

```sh
node research/import-openfootball.mjs /path/to/football.json e6744429ee395bc86f247348c6184bb08d4eb361 > /tmp/mam-input.json
node research/compare-poisson.mjs /tmp/mam-input.json
```

The source snapshot contains 3,798 completed results across six leagues and two seasons.
The importer checks source shape, local dates, score ranges, duplicate conflicts and
half-time consistency. It records the upstream revision and each file's SHA-256.
The archive verification flags describe the offline import. No second provider
verified each individual record.

For each league and period, pre-2025 forecasts fit a provisional Dixon–Coles
correction. January to July 2025 outcomes select the window and recency half-life
on common eligible fixtures. The selected configuration is refit through July 2025
and frozen. August to December is the reliability calibration period for the five
main-cohort leagues. The common holdout starts on January 1, 2026. Süper Lig has a
separate October 1, 2025 holdout because the pinned source ends on November 3, 2025.
The score history and league means at each prediction exclude the target day
and the preceding calendar day. Previous holdout results may enter later
predictions after this lag, but they never refit hyperparameters.

The report includes each evaluated configuration and the held-out metrics. All
three versions use the same eligible games for each period. Coverage is lower
where source seasons or period scores are incomplete. Brier for 1X2 sums the
squared errors over all three classes. ECE uses ten equal-width top-label bins.
Exact-score log loss evaluates the probability of the observed score. Binary
Brier covers BTTS and the three over/under thresholds.

The venue-count reliability thresholds did not validate. For full time, the
higher-coverage group had higher test log loss than the lower-coverage group.
For half time the calibration data did not identify three supported bands.
Keep reliability labels out of the application until richer evidence supports them.

## Reproduced paired holdout summary

The pinned OpenFootball snapshot was re-imported in GitHub Actions and the comparison
was rerun from source. The workflow validated 12 input-file SHA-256 records, six
leagues, and 889 common held-out matches for each period and each model.

| Period | Model | Matches | 1X2 Brier | 1X2 log loss | Top-label ECE | Accuracy |
|---|---:|---:|---:|---:|---:|---:|
| Full time | v1.2 | 889 | 0.623704 | 1.050174 | 0.092305 | 0.503937 |
| Full time | v1.3 | 889 | 0.609782 | 1.021638 | 0.045452 | 0.500562 |
| Full time | v1.4 | 889 | 0.600068 | 1.004716 | 0.013430 | 0.517435 |
| Half time | v1.2 | 889 | 0.689829 | 1.275484 | 0.123717 | 0.398200 |
| Half time | v1.3 | 889 | 0.670609 | 1.119035 | 0.095279 | 0.386952 |
| Half time | v1.4 | 889 | 0.654555 | 1.084690 | 0.047410 | 0.401575 |

v1.2 remains the default. v1.3 is an experimental three-match league-average
shrinkage prior for venue samples. v1.4 uses recency-weighted venue rates, five
league-average pseudo-matches and a Dixon–Coles low-score correction fitted on
earlier fixtures. The test period is shared, but the selected window and
half-life are fitted independently by league and period using the preceding
tuning window.

These results support further evaluation of v1.4, not automatic promotion.
The sample is a pinned public archive validated for source format and internal
consistency; individual rows were not independently verified against a second
provider. Venue-count reliability remains unvalidated, so the application must
not present confidence labels derived from these bands. This comparison does
not replace the separate 24-fixture point-in-time ESPN v1.2 evidence set.
