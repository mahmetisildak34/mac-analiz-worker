import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import worker from "../worker.js";
import adapter from "../a4-b-data-center-adapter.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = JSON.parse(fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8"));
const workerSource = fs.readFileSync(path.join(root, "worker.js"), "utf8");
function guardedDb() {
  const tracker = { calls: 0 };
  tracker.DB = { prepare() { tracker.calls++; throw new Error("DB must not be reached while B is disabled"); } };
  return tracker;
}

test("B release gate requires both exact environment approval and KV runtime switch, failing closed on errors", async () => {
  assert.equal(await adapter.isDataCenterEnabled({}), false);
  assert.equal(await adapter.isDataCenterEnabled({ MAM_DATA_CENTER_B_RELEASE_GATE: "true" }), false);
  assert.equal(await adapter.isDataCenterEnabled({ MAM_DATA_CENTER_B_RELEASE_GATE: "false", MAM_KV: { get: async () => "on" } }), false);
  assert.equal(await adapter.isDataCenterEnabled({ MAM_DATA_CENTER_B_RELEASE_GATE: "true", MAM_KV: { get: async () => "off" } }), false);
  assert.equal(await adapter.isDataCenterEnabled({ MAM_DATA_CENTER_B_RELEASE_GATE: "true", MAM_KV: { get: async () => { throw Error("KV unavailable"); } } }), false);
  assert.equal(await adapter.isDataCenterEnabled({ MAM_DATA_CENTER_B_RELEASE_GATE: "true", MAM_KV: { get: async () => "on" } }), true);
});

test("daily preparation exits before D1 access when either switch is closed", async () => {
  const releaseClosed = guardedDb();
  let kvReads = 0;
  await worker.scheduled({ cron: adapter.DAILY_B_CRON_UTC }, {
    MAM_DATA_CENTER_B_RELEASE_GATE: "false",
    MAM_KV: { async get() { kvReads++; return "on"; } },
    DB: releaseClosed.DB
  }, {});
  assert.equal(kvReads, 0, "the release gate short-circuits before KV or D1 when env approval is absent");
  assert.equal(releaseClosed.calls, 0);

  const runtimeClosed = guardedDb();
  await worker.scheduled({ cron: adapter.DAILY_B_CRON_UTC }, {
    MAM_DATA_CENTER_B_RELEASE_GATE: "true",
    MAM_KV: { async get() { return "off"; } },
    DB: runtimeClosed.DB
  }, {});
  assert.equal(runtimeClosed.calls, 0);
});

test("fixture-bundle endpoint returns fast no-store 503 and never reads D1 when disabled or KV fails", async () => {
  const request = new Request("https://worker.test/api/data-center/fixture-bundle?provider=espn&fixtureId=fixture-1");
  const closedEnvironments = [
    { DB: null },
    { MAM_DATA_CENTER_B_RELEASE_GATE: "false", MAM_KV: { async get() { return "on"; } } },
    { MAM_DATA_CENTER_B_RELEASE_GATE: "true", MAM_KV: { async get() { return "off"; } } },
    { MAM_DATA_CENTER_B_RELEASE_GATE: "true", MAM_KV: { async get() { throw Error("KV unavailable"); } } }
  ];
  for (const env of closedEnvironments) {
    const tracker = guardedDb();
    const response = await worker.fetch(request, { ...env, DB: tracker.DB }, {});
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.match(await response.text(), /B snapshot is unavailable/);
    assert.equal(tracker.calls, 0, "closed B must not touch D1");
  }
});

test("an opened gate reaches only the B read and keeps D1 failure on the existing fallback response", async () => {
  let d1Reads = 0;
  const response = await worker.fetch(
    new Request("https://worker.test/api/data-center/fixture-bundle?provider=espn&fixtureId=fixture-1"),
    { MAM_DATA_CENTER_B_RELEASE_GATE: "true", MAM_KV: { async get() { return "on"; } },
      DB: { prepare() { d1Reads++; throw Error("isolated unavailable-schema simulation"); } } },
    {}
  );
  assert.ok(d1Reads > 0, "the two-key gate permits the endpoint to attempt the B read");
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("both release defaults remain false and the five-minute cron is preserved", () => {
  assert.equal(wrangler.vars.MAM_DATA_CENTER_B_RELEASE_GATE, "false");
  assert.equal(wrangler.previews.vars.MAM_DATA_CENTER_B_RELEASE_GATE, "false");
  assert.deepEqual(wrangler.triggers.crons, ["*/5 * * * *", adapter.DAILY_B_CRON_UTC]);
  assert.match(workerSource, /if \(event\?\.cron === bAdapter\.DAILY_B_CRON_UTC\)/);
});
