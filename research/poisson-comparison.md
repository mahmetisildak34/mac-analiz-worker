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
