import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../worker.js", import.meta.url), "utf8");

const initStart = worker.indexOf('const stateKey = "mam:espn-sync-state:v2"');
assert.notEqual(initStart, -1, "archive state key must exist");
const initEnd = worker.indexOf("\n  } else {", initStart);
assert.notEqual(initEnd, -1, "archive state initialization branch must exist");
const initCondition = worker.slice(initStart, initEnd);
assert.doesNotMatch(
  initCondition,
  /state\.cursor\s*>=\s*state\.jobs\.length/,
  "a completed cursor must not be treated as a missing state"
);

const completionStart = worker.indexOf("state.cursor += batch.length");
assert.notEqual(completionStart, -1, "archive cursor must be advanced");
const completionEnd = worker.indexOf('if (maxRequests > 10)', completionStart);
assert.notEqual(completionEnd, -1, "archive completion persistence block must exist");
const completionBlock = worker.slice(completionStart, completionEnd);
assert.match(
  completionBlock,
  /await env\.MAM_KV\.put\(stateKey, JSON\.stringify\(state\)\)/,
  "completed archive cursor must be persisted"
);
assert.doesNotMatch(
  completionBlock,
  /MAM_KV\.delete\(stateKey\)/,
  "completed archive cursor must not be deleted"
);

assert.match(
  completionBlock,
  /const complete = state\.cursor >= state\.jobs\.length;/,
  "completion status must be calculated after cursor and retry jobs are updated"
);

console.log("archive completion checkpoint regression test passed");
