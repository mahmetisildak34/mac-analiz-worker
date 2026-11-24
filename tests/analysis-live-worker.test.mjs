import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateLiveV1 } from "../analysis-live-v1.mjs";

test("live worker model keeps existing score, minute and bounded probabilities", () => {
  const result = calculateLiveV1({ minute: 45, homeScore: 1, awayScore: 0, home: { sot: 3, shots: 8, possession: 55, corners: 4, redCards: 0, xg: .9 }, away: { sot: 2, shots: 6, possession: 45, corners: 2, redCards: 1, xg: .4 } });
  assert.equal(result.model, "live-v1");
  assert.equal(result.minute, 45);
  assert.equal(result.remaining, 45);
  for (const key of ["homeWin", "draw", "awayWin", "over15", "over25", "over35", "btts", "nextHome", "nextAway", "noGoal"]) assert.ok(result[key] >= 0 && result[key] <= 1, key);
  assert.ok(Math.abs(result.homeWin + result.draw + result.awayWin - 1) < .002);
  assert.ok(Math.abs(result.nextHome + result.nextAway + result.noGoal - 1) < 1e-12);
});

test("live model rejects missing inputs instead of issuing a result", () => {
  assert.throws(() => calculateLiveV1({ minute: 0 }), /Invalid live-analysis input/);
});
