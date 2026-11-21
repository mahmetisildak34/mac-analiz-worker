# Provider coverage decision — 2026-11-21

## Counts (strict evidence levels)
- Immutable plan rows: **678**; protected plan, 12 JSON, 44 historical records unchanged.
- StatsBomb Open Data **exact competition+season candidates established: 0**. Source competition list was inspected; the 2024–2026 Champions League seasons were not listed, nor target seasons for the other named competitions. This is not a claim that no StatsBomb data could ever match any plan fixture; it means no exact row was demonstrated from the accessible official index.
- StatsBomb match-level identities independently verified: **0**.
- Sportmonks **competition-only candidates: 54** (23 UEFA Champions League, 16 `champions-league 2024`, 15 `champions-league 2026`). Its public coverage page lists Champions League and match statistics, but **no exact plan season or fixture was verified**; therefore **competition+season confirmed: 0**.
- Sportradar **competition+season confirmed: 0**. Official interactive matrix exposes season IDs and separate Basic/Deeper coverage; none of the 678 exact competition/season rows was independently confirmed here.
- Unknown at strict competition+season+seven-stat level: **678**.

## Requested competition checks
| Competition | Sportmonks official public evidence | Sportradar official evidence | Seven stats for target season |
|---|---|---|---|
| Coupe de France | Named as a French covered competition in FAQ; fixture/round depth not verified | Coverage varies by cup round | Unknown, especially early rounds |
| UEFA Champions League | League #2 listed with match stats and historical-data category | Season-specific matrix required | Unknown for 2024/2026 |
| UEFA U21 qualification | No verified exact season coverage | Season-specific matrix required | Unknown |
| Spain Segunda | No verified exact season coverage | Season-specific matrix required | Unknown |
| Japan J1/J2/J3 | No verified exact season coverage | Season-specific matrix required | Unknown |
| CONCACAF Nations League | No verified exact season coverage | Season-specific matrix required | Unknown |

The Sportmonks public coverage finder requires login to expose exact league-by-season field details. Free access to the requested target leagues and historical fixture statistics was **not confirmed**. The Sportradar matrix offers season-by-season coverage, but basic cards and deeper shots/corners may be separately classified; a green competition label alone is not proof of all seven metrics. Historical availability must be checked against package and retention rules.

## Source evidence
- StatsBomb actual competition index: https://raw.githubusercontent.com/statsbomb/open-data/master/data/competitions.json
- Sportmonks public league coverage: https://www.sportmonks.com/football-api/coverage/
- Sportmonks French competitions FAQ: https://www.sportmonks.com/faq/
- Sportradar season matrix: https://coverage-matrix.sm-row-prod.sportradar.com/
- Sportradar interpretation: https://developer.sportradar.com/soccer/docs/soccer-ig-data-coverage-tiers
- Sportradar archived data warning: https://developer.sportradar.com/soccer/reference/soccer-extended-faq

## Cost decision
No subscription is justified by demonstrated rescued fixtures (**0**). Exact price/package/redistribution terms must be obtained before purchasing. First obtain a free or no-charge season-level export/sample from Sportmonks or a Sportradar sales evaluation, map season+competition identifiers and require a real sample of all seven stats. Keep source|fixture_id as immutable namespace; do not merge IDs numerically. Do not auto-run or promote any fixture without evidence.
