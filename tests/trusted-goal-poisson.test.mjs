import assert from "node:assert/strict";
import { predictTrustedGoals } from "../trusted-goal-poisson.js";
const row = (id, home, away, hg, ag, day, extra = {}) => ({
  source: "api-football", fixture_id: id, home_team: home, away_team: away,
  home_goals: hg, away_goals: ag, kickoff: `2026-10-${String(day).padStart(2,"0")}T12:00:00Z`,
  identity_verified: true, score_verified: true, completed: true, ...extra
});
const matches = [
  row("h1","Espanyol","A",2,0,1), row("h2","Espanyol","B",1,0,2),
  row("h3","Espanyol","C",3,1,3), row("h4","Espanyol","D",2,1,4),
  row("h5","Espanyol","E",1,1,5), row("h6","Espanyol","F",4,0,6),
  row("a1","G","Athletic Club",0,1,1), row("a2","H","Athletic Club",1,2,2),
  row("a3","I","Athletic Club",2,1,3), row("a4","J","Athletic Club",0,2,4),
  row("a5","K","Athletic Club",1,1,5), row("a6","L","Athletic Club",1,3,6)
];
const options = { home_team:"Espanyol", away_team:"Athletic Club", as_of:"2026-11-21T00:00:00Z",
  league_average_home_goals:1.5, league_average_away_goals:1.2, min_matches:5, max_matches:5 };
const test = (name, fn) => { fn(); console.log("PASS " + name); };
test("produces venue-aware trusted Poisson and evidence", () => {
  const result = predictTrustedGoals(matches, options);
  assert.equal(result.available, true);
  assert.equal(result.home_samples, 5); assert.equal(result.away_samples, 5);
  assert.equal(result.used, 10); assert.equal(result.used_fixtures.length, 10);
  assert.ok(result.used_fixtures.every(x => x.source && x.fixture_id && x.kickoff));
});
test("caps each team to newest five eligible fixtures", () => {
  const result = predictTrustedGoals(matches, options);
  assert.ok(!result.used_fixtures.some(x => ["h1","a1"].includes(x.fixture_id)));
  assert.equal(result.reasons.outside_last_n, 2);
});
test("blocks fewer than five verified venue fixtures", () => {
  assert.equal(predictTrustedGoals(matches.slice(0, 8), options).reason, "insufficient_verified_venue_sample");
});
test("uses a shared ESPN fixture once and rejects conflicting verified copies", () => {
  const fixture = row("espn-fra.1-401876395", "Espanyol", "F", 3, 1, 7, {source:"ESPN"});
  const mirror = {...fixture, source:"app"};
  const baseline = predictTrustedGoals([fixture, ...matches], options);
  for (const copies of [[mirror, fixture], [fixture, mirror]]) {
    const result = predictTrustedGoals([...copies, ...matches], options);
    assert.equal(result.reasons.duplicate_fixture, 1);
    assert.deepEqual(result.probabilities, baseline.probabilities);
    assert.deepEqual(result.used_fixtures.filter(x => x.fixture_id === fixture.fixture_id).map(x => x.source), ["ESPN"]);
  }
  for (const source of ["app", "ESPN"]) {
    const conflict = {...mirror, source, home_goals:0, away_goals:0};
    const result = predictTrustedGoals([conflict, fixture, ...matches], options);
    assert.equal(result.reasons.conflicting_fixture, 2);
    assert.ok(!result.used_fixtures.some(x => x.fixture_id === fixture.fixture_id));
  }
});
test("excludes unverified scores and identities", () => {
  const data = [...matches, row("bad-score","Espanyol","X",2,0,7,{score_verified:false}),
    row("bad-id","X","Athletic Club",0,1,7,{identity_verified:false})];
  const result = predictTrustedGoals(data, options);
  assert.equal(result.available, true);
  assert.equal(result.reasons.score_not_verified, 1);
  assert.equal(result.reasons.identity_not_verified, 1);
});
test("excludes fixtures not confirmed finished", () => {
  const result = predictTrustedGoals([...matches, row("pending","Espanyol","X",2,0,7,{completed:false})], options);
  assert.equal(result.reasons.not_confirmed_finished, 1);
});
test("home and away venue samples remain separate", () => {
  const result = predictTrustedGoals([...matches, row("neutral","Espanyol","Athletic Club",9,9,7)], options);
  assert.equal(result.home_samples, 5); assert.equal(result.away_samples, 5);
  assert.equal(result.reasons.not_relevant_home_or_away_venue, 1);
});
test("defensive weakness changes the opposing expected goals", () => {
  const baseline = predictTrustedGoals(matches, options);
  const strongerAwayDefence = matches.map(m => m.fixture_id.startsWith("a") ? {...m, home_goals:0} : m);
  const changed = predictTrustedGoals(strongerAwayDefence, options);
  assert.ok(changed.lambda_home < baseline.lambda_home);
});
test("BTTS and over/under probabilities are complementary", () => {
  const p = predictTrustedGoals(matches, options).probabilities;
  assert.ok(Math.abs(p.btts_yes + p.btts_no - 1) < 1e-10);
  assert.ok(Math.abs(p.over_2_5 + p.under_2_5 - 1) < 1e-10);
});
test("match outcome probabilities sum to one", () => {
  const p = predictTrustedGoals(matches, options).probabilities;
  assert.ok(Math.abs(p.home_win + p.draw + p.away_win - 1) < 1e-10);
});
test("returns ranked scorelines", () => {
  const result = predictTrustedGoals(matches, options);
  assert.equal(result.most_likely_scores.length, 5);
  assert.ok(result.most_likely_scores[0].probability >= result.most_likely_scores[1].probability);
});
test("requires explicit league averages; does not invent baselines", () => {
  const {league_average_home_goals, league_average_away_goals, ...withoutAverages} = options;
  assert.equal(predictTrustedGoals(matches, withoutAverages).reason, "missing_league_averages");
});
test("rejects malformed input", () => {
  assert.equal(predictTrustedGoals(null, options).reason, "invalid_request");
  assert.equal(predictTrustedGoals(matches, {...options, max_matches:11}).reason, "invalid_request");
});
