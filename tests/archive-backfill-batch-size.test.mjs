import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");
assert.match(worker, /syncEspnFixturesToD1\(env, 900, 180, isHourlySync \? 32 : 10\)/, "hourly archive backfill budget is 32, daily remains 10");
console.log("archive backfill batch-size regression test passed");
