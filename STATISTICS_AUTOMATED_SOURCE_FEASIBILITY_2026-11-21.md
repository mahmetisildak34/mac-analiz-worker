# Automatic football statistics source feasibility — 2026-11-21

Research-only. No production writes, no API-Football requests, no automatic promotion.

| Source | Officially documented access | Key / cost | Historical matches | Seven match statistics | Decision |
|---|---|---|---|---|---|
| TheSportsDB v1 | Public JSON API; shared key `123`; 30 requests/minute per official quickstart; endpoint-specific free result limits | Free shared key, no signup; premium $9/month | Event lookup exists, but free coverage limited | `lookupeventstats.php` exists, but actual sample `id=1032723` returns only 5 stats (Shots on Goal, Shots off Goal, Total Shots, Blocked Shots, Shots insidebox); `idApiFootball` identifies upstream API-Football provenance | Suitable only for bounded read-only pilot; cannot automatically approve seven stats or treat as independent source |
| OpenLigaDB | Official OpenAPI; no key; ODbL 1.0; 60 requests/min/IP; polite polling requested | Free | Match and season endpoints | Standard match schema centers on result/goals; seven required match stats not demonstrated | Match identity/score candidate, not a full-stat provider |
| football-data.org | Official token API, 10 requests/min free | Free score tier; statistic add-on €15/month *plus regular plan* | Historical coverage plan-dependent | Statistics not included in free tier | Not authorized for this no-new-key/no-cost pilot |
| StatsBomb open data | Public GitHub datasets; individual competition and match events, limited curated competitions | Public dataset | Selected historical competitions | Event-derived stats may be computed, but possession and cards require carefully documented definitions; coverage of 678-plan fixtures not established | Offline research candidate only, not a general-purpose feed |
| football-data.co.uk | Published CSVs; usage restrictions may exclude automated commercial/AI collection | Free for permitted use | Historical leagues | Shots/corners/fouls/cards often present, possession absent | Not approved for automatic scraping or full seven-stat verification |

## Reproducible endpoint probe
Documented free sample:
`https://www.thesportsdb.com/api/v1/json/123/lookupeventstats.php?id=1032723`

A web retrieval returned JSON for **Aston Villa vs Liverpool**, five stat types, and upstream `idApiFootball=592172`. This is a *historically indexed response*, **not proof of a fresh HTTP request from the GitHub Actions runner**. The source does not contain the required seven stats; this sample is not in the plan and cannot be promoted.

## Production-readiness gates
1. Confirm that the exact intended automated use and redistribution are allowed by the provider's terms.
2. Confirm real HTTP GET from a controlled GitHub Actions runner, including status, response schema, and rate-limit headers.
3. Crosswalk plan `source|fixture_id` to provider event ID, independently check kickoff/competition/home/away/score.
4. Require all seven metrics for both teams, same provider, documented regulation-time scope, and trustworthy provenance.
5. Write candidate evidence only to feature branch after separate integrity tests; never auto-promote copied or ambiguous upstream records.
6. No schedule or mass batch execution until a plan fixture passes a real end-to-end pilot.

References:
- https://www.thesportsdb.com/API.php
- https://www.thesportsdb.com/documentation
- https://api.openligadb.de/index.html
- https://www.football-data.org/pricing
- https://docs.football-data.org/general/v4/policies.html
- https://github.com/statsbomb/open-data
