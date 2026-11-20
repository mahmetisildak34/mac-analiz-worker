import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");

assert.match(worker, /SELECT DISTINCT league_id, substr\(kickoff, 1, 10\) AS match_day FROM matches WHERE source = 'ESPN'/,
  "archive checks D1 for already represented ESPN league/date pairs before fetching");
assert.match(worker, /jobsToFetch = batch\.filter\(job =>/,
  "only league/date pairs absent from D1 are sent to ESPN");
assert.match(worker, /for \(let i = 0; i < jobsToFetch\.length; i \+= 4\)/,
  "existing dates do not consume scoreboard requests");
assert.match(worker, /state\.cursor \+= batch\.length/,
  "skipped existing dates still advance the durable archive cursor");
assert.match(worker, /mam:espn-archive-skip-last:v1/,
  "skip counts are recorded for live verification");

console.log("ESPN archive existing-date skip regression test passed");
