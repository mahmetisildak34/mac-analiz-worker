import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const worker = readFileSync(new URL("../worker.js", import.meta.url), "utf8");

test("Worker Preview uses the isolated D1/KV bindings and the Pages Preview CORS origin only", () => {
  assert.equal(config.preview_urls, true);
  assert.equal(config.name, "odd-sunset-6c83");
  assert.deepEqual(config.d1_databases.map(binding => binding.database_id), ["b3103550-8f93-4109-8a24-e0095c49e666"]);
  assert.deepEqual(config.kv_namespaces.map(binding => binding.id), ["4de80ce8f698470e833d9773d6724b94"]);
  assert.deepEqual(config.triggers.crons, ["*/5 * * * *", "1 21 * * *"]);
  assert.deepEqual(config.previews.d1_databases.map(binding => binding.database_id), ["704a5c24-491f-455f-b62a-23752083f085"]);
  assert.deepEqual(config.previews.kv_namespaces.map(binding => binding.id), ["5e90bdd4b76c4a2eb7a88381966f0f3e"]);
  assert.equal(config.vars.MAM_PREVIEW_ORIGIN, undefined, "Preview CORS must not be configured for production");
  assert.equal(config.previews.vars.MAM_PREVIEW_ORIGIN, "https://repair-team-identity-history-20261128.mam-iphone-preview.pages.dev");
  assert.match(worker, /typeof env\.MAM_PREVIEW_ORIGIN === "string"/);
  assert.match(worker, /\.\.\(previewOrigin \? \[previewOrigin\] : \[\]\)/);
});
