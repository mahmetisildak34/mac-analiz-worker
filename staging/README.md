# Isolated Cloudflare integration gate

No Cloudflare resource is created by this branch.

1. Read-only smoke test: `staging/wrangler.readonly.jsonc` and `staging/read-only-worker.js` bind existing production and preview D1. No scheduled triggers, no mutation SQL and no football API code. The D1 binding itself is **not** permission-scoped read-only; safety relies on the dedicated Worker source and review. Do not expose /health publicly without access control.
2. Write and concurrency tests require a **new third D1 database**, separate from both existing databases. Its database ID must be supplied only after the user approves creation. Never bind production or preview D1 to the write-test Worker.
3. A real deployed Worker test is **not yet performed**. Deployment of the isolated Worker and creation of test D1 require explicit user approval.
4. Verify the real API-Football subscription daily quota from the provider dashboard. Existing D1 usage counters do not prove the provider limit. Audit all four Worker scripts' API key usage and quota guard implementation before enabling external downloads.
5. API cron remains disabled by default, including on the isolated Worker. No upstream requests during staging binding checks.

## First five of the 44 historical matches
Use a read-only matching manifest with unique fixture, date, home/away, score, known IDs, and two-team nonempty stats. Before any approved write, snapshot all five production rows, verify they remain empty, and apply conditional empty-only updates one at a time with audit logs. Stop immediately if a row has changed. Remaining 39 must await inspection of the first five results.
