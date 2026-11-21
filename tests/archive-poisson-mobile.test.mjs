import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyzeArchiveFetchResponse, analyzeArchiveResponse } from "../docs/archive-poisson-client.js";

const archive = JSON.parse(readFileSync(new URL("../docs/archive-espn-example.json", import.meta.url)));
const options = {
  home_team: "Leeds United", away_team: "Tottenham Hotspur", league_id: "39", as_of: "2026-11-20T00:00Z",
  league_average_home_goals: 1.5, league_average_away_goals: 1.2,
  league_average_home_half_goals: 0.8, league_average_away_half_goals: 0.5,
};

test("archive failures do not expose stale or malformed forecast data", () => {
  for (const response of [{ status: 503, body: archive }, { status: 200, body: { response: {} } }, {}]) {
    const result = analyzeArchiveResponse(response, options);
    assert.equal(result.reason, "archive_unavailable");
    assert.equal(result.fullTime, undefined);
    assert.equal(result.firstHalf, undefined);
  }
});

test("a real ESPN record alone is insufficient for both periods", () => {
  const result = analyzeArchiveResponse({ status: 200, body: archive }, options);
  assert.equal(result.available, false);
  for (const period of [result.fullTime, result.firstHalf]) {
    assert.equal(period.reason, "insufficient_verified_venue_sample");
    assert.equal(period.probabilities, undefined);
  }
  assert.equal(result.firstHalf.reasons.score_not_verified, 1);
});

test("periods, league identity and conflict flags are enforced independently", () => {
  const sample = archive.response[0];
  const rows = Array.from({ length: 10 }, (_, i) => ({
    ...sample,
    fixture: { ...sample.fixture, id: "espn-eng.1-" + (9000 + i) },
    teams: i < 5 ? { home: sample.teams.home, away: { id: "" + i, name: "Opponent " + i } } :
      { home: { id: "" + i, name: "Opponent " + i }, away: sample.teams.away },
    score: { halftime: { home: 0, away: 0 } },
  }));
  const request = response => ({ status: 200, body: { response } });
  const result = analyzeArchiveResponse(request(rows), options);
  assert.equal(result.fullTime.available, true);
  assert.equal(result.firstHalf.available, false);
  assert.equal(result.fullTime.model_version, "venue-poisson-v1.2");
  assert.equal(result.fullTime.home_samples, 5);
  assert.equal(result.fullTime.away_samples, 5);
  const verified = rows.map(row => ({ ...row, halftime_score_verified: true }));
  assert.equal(analyzeArchiveResponse(request(verified), options).firstHalf.available, true);
  for (const changed of [{ conflicting: true }, { league: { id: "different" } }]) {
    const blocked = analyzeArchiveResponse(request([{ ...verified[0], ...changed }, ...verified.slice(1)]), options);
    assert.equal(blocked.available, false);
  }
});

test("fetch response adapter distinguishes invalid JSON from HTTP 503 and never forecasts either", async () => {
  const broken = await analyzeArchiveFetchResponse(new Response('{"response":', { status: 200 }), options);
  assert.deepEqual(broken, { available: false, reason: "archive_invalid_json", http_status: 200 });
  const down = await analyzeArchiveFetchResponse(new Response(JSON.stringify(archive), { status: 503 }), options);
  assert.deepEqual(down, { available: false, reason: "archive_unavailable", http_status: 503 });
  const good = await analyzeArchiveFetchResponse(Response.json(archive), options);
  assert.deepEqual(good, analyzeArchiveResponse({ status: 200, body: archive }, options));
});
