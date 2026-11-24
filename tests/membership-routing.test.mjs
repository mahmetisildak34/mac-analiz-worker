import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker.js";

test("anonymous fixture/scoreboard reads remain public", async () => {
  const originalFetch = globalThis.fetch;
  let requested = "";
  globalThis.fetch = async input => {
    requested = String(input);
    return new Response(JSON.stringify({ events: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const response = await worker.fetch(new Request("https://worker.test/api/espn/eng.1/scoreboard"), {});
    assert.equal(response.status, 200);
    assert.match(requested, /^https:\/\/site\.api\.espn\.com\/apis\/site\/v2\/sports\/soccer\/eng\.1\/scoreboard/);
  } finally { globalThis.fetch = originalFetch; }
});

test("anonymous archive diagnostics remain protected", async () => {
  for (const route of ["archive/quality-check", "archive/priority-league-status"]) {
    const response = await worker.fetch(new Request(`https://worker.test/api/${route}`), {});
    assert.equal(response.status, 401, route);
  }
});
