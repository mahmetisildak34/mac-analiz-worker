import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { TextEncoder } from "node:util";

const source = readFileSync(new URL("../worker.js", import.meta.url), "utf8");
const context = {
  Response,
  Request,
  Headers,
  URL,
  URLSearchParams,
  TextEncoder,
  crypto: webcrypto,
  fetch,
  console,
  setTimeout,
  clearTimeout,
  atob,
  btoa
};
runInNewContext(source.replace("export default {", "globalThis.worker = {"), context);

const compareText = (a, b) => String(a) === String(b) ? 0 : String(a) < String(b) ? -1 : 1;
const compareTuple = (a, b) => compareText(a.kickoff, b.kickoff) ||
  compareText(a.source, b.source) || compareText(a.fixture_id, b.fixture_id);
const newestFirst = (a, b) => -compareTuple(a, b);

function row({ source = "ESPN", fixtureId, kickoff, leagueId = "39", leagueName = "Premier League", country = "England", home = "Unrelated Club", away = "Another Club", homeGoals = 1, awayGoals = 0 }) {
  return {
    source,
    fixture_id: fixtureId,
    league_id: String(leagueId),
    league_name: leagueName,
    country,
    kickoff,
    status: "FT",
    home_team_id: null,
    home_team: home,
    away_team_id: null,
    away_team: away,
    home_goals: homeGoals,
    away_goals: awayGoals,
    statistics_json: null,
    raw_json: null
  };
}

function fakeDb(rows) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      let values = [];
      return {
        bind(...nextValues) {
          values = nextValues;
          return {
            async all() {
            calls.push({ sql, values });
            const [leagueId, before] = values;
              let eligible = rows.filter(item => item.league_id === leagueId && item.kickoff < before);
              if (sql.includes("home_team COLLATE NOCASE IN")) {
                const nameCount = (values.length - 3) / 2;
                const names = new Set(values.slice(2, 2 + nameCount).map(value => String(value).toLowerCase()));
                eligible = eligible.filter(item => names.has(String(item.home_team).toLowerCase()) || names.has(String(item.away_team).toLowerCase()));
              }
              return { results: eligible.sort(newestFirst).slice(0, values.at(-1)) };
            }
          };
        }
      };
    }
  };
}

function request(query) {
  return new Request("https://mam-worker.test/api/archive/matches?" + query, {
    method: "GET",
    headers: { Origin: "https://mahmetisildak34.github.io" }
  });
}

test("teamNames uses the indexed team predicate and finds older fixtures without unrelated-row paging", async () => {
  const newestKickoff = "2026-11-24T12:00:00.000Z";
  const rows = Array.from({ length: 2600 }, (_, index) => row({
    fixtureId: "z" + String(index).padStart(5, "0"),
    kickoff: newestKickoff,
    home: "Unrelated Club " + index
  }));
  rows.push(
    row({ fixtureId: "target-2", kickoff: "2026-10-20T12:00:00.000Z", home: "Hoffenheim", away: "Liverpool" }),
    row({ fixtureId: "target-1", kickoff: "2026-10-19T12:00:00.000Z", home: "TSG 1899 Hoffenheim", away: "Dortmund" })
  );
  const DB = fakeDb(rows);
  const response = await context.worker.fetch(request(
    "league=39&before=2026-11-25&limit=10&teamNames=Hoffenheim%2CTSG%201899%20Hoffenheim"
  ), { DB });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.teamFilterApplied, true);
  assert.equal(payload.count, 2);
  assert.equal(payload.rawCount, 2);
  assert.equal(payload.scanLimitReached, false);
  assert.deepEqual(payload.response.map(match => match.fixture.id), ["target-2", "target-1"]);
  assert.ok(payload.response.every(match => match.mamArchiveOnly === true));
  assert.ok(payload.response.every(match => match.mamSource === "espn"));
  assert.equal(DB.calls.length, 1, "team history should be read through one indexed name predicate, not unrelated-row pages");
  assert.ok(DB.calls[0].sql.includes("home_team COLLATE NOCASE IN"));
  assert.ok(DB.calls[0].sql.includes("away_team COLLATE NOCASE IN"));
  assert.match(source, /idx_matches_league_home_team_kickoff ON matches \(league_id, home_team COLLATE NOCASE, kickoff DESC\)/);
  assert.match(source, /idx_matches_league_away_team_kickoff ON matches \(league_id, away_team COLLATE NOCASE, kickoff DESC\)/);
});

test("unfiltered archive reads keep the existing single bounded query behavior", async () => {
  const DB = fakeDb(Array.from({ length: 80 }, (_, index) => row({
    fixtureId: String(index).padStart(4, "0"),
    kickoff: "2026-11-24T12:00:00.000Z"
  })));
  const response = await context.worker.fetch(request("league=39&before=2026-11-25&limit=25"), { DB });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.teamFilterApplied, false);
  assert.equal(payload.count, 25);
  assert.equal(payload.rawCount, 25);
  assert.equal(DB.calls.length, 1);
  assert.ok(!DB.calls[0].sql.includes("(kickoff, source, fixture_id) < (?, ?, ?)"));
});

test("team-filter miss returns from a selective query without scanning unrelated archive rows", async () => {
  const DB = fakeDb(Array.from({ length: 6000 }, (_, index) => row({
    fixtureId: String(index).padStart(5, "0"),
    kickoff: "2026-11-24T12:00:00.000Z",
    home: "Different Club " + index
  })));
  const response = await context.worker.fetch(request(
    "league=39&before=2026-11-25&limit=10&teamNames=Never%20Played%20Here"
  ), { DB });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.count, 0);
  assert.equal(payload.rawCount, 0);
  assert.equal(payload.scanLimitReached, false);
  assert.equal(DB.calls.length, 1);
  assert.ok(DB.calls[0].sql.includes("home_team COLLATE NOCASE IN"));
});

test("real D1 matches from six leagues and tournaments resolve through the same archive route", async () => {
  // Read-only Cloudflare D1 sample captured 2026-11-25; no provider download is used by this test.
  const realRows = [
    row({ leagueId: "128", leagueName: "Liga Profesional Argentina", country: "Argentina", source: "app", fixtureId: "1649568", kickoff: "2026-11-23T04:00:00+03:00", home: "Instituto Cordoba", away: "Huracan", homeGoals: 2, awayGoals: 1 }),
    row({ leagueId: "128", leagueName: "Liga Profesional", country: "Argentina", source: "ESPN", fixtureId: "espn-arg.1-401933756", kickoff: "2026-11-23T20:00Z", home: "Gimnasia La Plata", away: "Newell's Old Boys", homeGoals: 0, awayGoals: 0 }),
    row({ leagueId: "140", leagueName: "La Liga", country: "Spain", source: "app", fixtureId: "espn-esp.1-401882803", kickoff: "2026-11-22T20:00Z", home: "Getafe", away: "Atlético Madrid", homeGoals: 0, awayGoals: 2 }),
    row({ leagueId: "140", leagueName: "La Liga", country: "Spain", source: "ESPN", fixtureId: "espn-esp.1-401882802", kickoff: "2026-11-23T20:00Z", home: "Levante", away: "Elche", homeGoals: 0, awayGoals: 0 }),
    row({ leagueId: "203", leagueName: "Süper Lig", country: "Türkiye", source: "app", fixtureId: "espn-tur.1-401888370", kickoff: "2026-11-23T17:00Z", home: "Istanbul Basaksehir", away: "Çorum FK", homeGoals: 4, awayGoals: 2 }),
    row({ leagueId: "203", leagueName: "Süper Lig", country: "Türkiye", source: "ESPN", fixtureId: "espn-tur.1-401888370", kickoff: "2026-11-23T17:00Z", home: "Istanbul Basaksehir", away: "Çorum FK", homeGoals: 0, awayGoals: 0 }),
    row({ leagueId: "39", leagueName: "Premier League", country: "England", source: "app", fixtureId: "espn-eng.1-401878755", kickoff: "2026-11-22T16:30Z", home: "Liverpool", away: "Manchester United", homeGoals: 4, awayGoals: 0 }),
    row({ leagueId: "39", leagueName: "Premier League", country: "England", source: "ESPN", fixtureId: "espn-eng.1-401879237", kickoff: "2026-11-23T20:00Z", home: "Brentford", away: "Everton", homeGoals: 0, awayGoals: 0 }),
    row({ leagueId: "3", leagueName: "UEFA Europa League", country: "Europe", source: "fixture-download-uefa", fixtureId: "espn-uefa.europa-401915532", kickoff: "2026-11-05T20:00Z", home: "Hapoel Be'er", away: "OFI Crete", homeGoals: 0, awayGoals: 2 }),
    row({ leagueId: "3", leagueName: "UEFA Europa League", country: "Europe", source: "fixture-download-uefa", fixtureId: "espn-uefa.europa-401915533", kickoff: "2026-11-05T20:00Z", home: "Bayer Leverkusen", away: "Marseille", homeGoals: 0, awayGoals: 1 }),
    row({ leagueId: "848", leagueName: "UEFA Conference League", country: "Europe", source: "ESPN", fixtureId: "espn-uefa.europa.conf-401915824", kickoff: "2026-11-05T20:00Z", home: "AS Monaco", away: "FC Nordsjælland", homeGoals: 2, awayGoals: 0 }),
    row({ leagueId: "848", leagueName: "UEFA Conference League", country: "Europe", source: "ESPN", fixtureId: "espn-uefa.europa.conf-401915823", kickoff: "2026-11-05T20:00Z", home: "FC Lugano", away: "Kauno Zalgiris", homeGoals: 3, awayGoals: 0 })
  ];
  const cases = [
    { league: "128", teamNames: ["Instituto Cordoba", "Huracan"], ids: ["1649568"] },
    { league: "140", teamNames: ["Getafe", "Atletico Madrid"], ids: ["espn-esp.1-401882803"] },
    { league: "203", teamNames: ["Basaksehir", "Çorum FK"], ids: ["espn-tur.1-401888370", "espn-tur.1-401888370"], score: [4, 2] },
    { league: "39", teamNames: ["Liverpool", "Manchester United"], ids: ["espn-eng.1-401878755"] },
    { league: "3", teamNames: ["Hapoel Be'er", "OFI Crete"], ids: ["espn-uefa.europa-401915532"] },
    { league: "848", teamNames: ["AS Monaco", "FC Nordsjælland"], ids: ["espn-uefa.europa.conf-401915824"] }
  ];

  for (const check of cases) {
    const DB = fakeDb(realRows);
    const query = new URLSearchParams({
      league: check.league,
      before: "2026-11-25",
      limit: "10",
      teamNames: check.teamNames.join(",")
    });
    const response = await context.worker.fetch(request(query.toString()), { DB });
    assert.equal(response.status, 200, "league " + check.league);
    const payload = await response.json();
    assert.equal(payload.count, check.ids.length, "league " + check.league);
    assert.deepEqual(payload.response.map(match => match.fixture.id), check.ids, "league " + check.league);
    assert.ok(payload.response.every(match => match.league.id === check.league));
    if (check.score) {
      assert.equal(payload.response[0].source, "app", "app score revision should sort before its conflicting ESPN duplicate");
      assert.deepEqual([payload.response[0].goals.home, payload.response[0].goals.away], check.score);
    }
  }
});
