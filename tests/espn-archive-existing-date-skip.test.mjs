import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");

assert.match(worker, /const jobsToFetch = batch;/,
  "every pending league/date job is fetched; one existing row cannot mark a whole day complete");
assert.doesNotMatch(worker, /SELECT DISTINCT league_id, substr\(kickoff, 1, 10\) AS match_day FROM matches WHERE source = 'ESPN'/,
  "the unsafe partial-day existence shortcut is removed");
assert.match(worker, /for \(let i = 0; i < jobsToFetch\.length; i \+= 4\)/,
  "scoreboard requests remain bounded to four concurrent jobs");
assert.match(worker, /state\.cursor \+= batch\.length/,
  "the durable cursor advances only across the considered batch");
assert.match(worker, /mam:espn-sync-state-backup:v1/,
  "the archive checkpoint has a recovery backup");
assert.match(worker, /refusing to create a new queue and reset progress/,
  "missing primary and backup checkpoints fail closed instead of silently resetting");

console.log("ESPN archive partial-day and checkpoint recovery regression test passed");
