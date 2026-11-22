import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stageUefaBackfill } from "../research/uefa-archive-backfill.mjs";

function fixture() {
  return {
    slug: "uefa.champions",
    espn: {
      url: "https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/scoreboard?dates=202611&limit=500",
      event: {
        id: "100", date: "2026-11-03T20:00Z",
        status: { type: { name: "STATUS_FULL_TIME", completed: true, state: "post" } },
        competitions: [{ competitors: [
          { homeAway: "home", team: { id: "101", displayName: "Galatasaray" }, score: "2" },
          { homeAway: "away", team: { id: "102", displayName: "VfB Stuttgart" }, score: "0" },
        ] }],
      },
    },
    uefa: {
      id: "2049614", url: "https://www.uefa.com/uefachampionsleague/match/2049614--galatasaray-vs-stuttgart/",
      day: "2026-11-03", home: "Galatasaray", away: "Stuttgart", homeGoals: 2, awayGoals: 0,
    },
  };
}

const run = (candidates, archive = []) => stageUefaBackfill({
  candidates, archive, before: "2026-11-22T00:00:00Z", aliases: { stuttgart: "VfB Stuttgart" },
});

test("local staging preserves both source URLs, the ESPN payload, and a verified zero score", () => {
  const candidate = fixture();
  const result = run([candidate]);
  assert.equal(result.staged.length, 1);
  const [row] = result.staged;
  assert.equal(row.fixture_id, "espn-uefa.champions-100");
  assert.equal(row.uefa_key, "2|2049614");
  assert.equal(row.away_goals, 0);
  assert.equal(row.uefa_url, candidate.uefa.url);
  assert.equal(row.espn_url, candidate.espn.url);
  assert.deepEqual(JSON.parse(row.evidence), { espn: candidate.espn.event, uefa: candidate.uefa });
});

test("score, calendar, identity, URL and completed status disagreements fail closed", () => {
  const wrongScore = fixture();
  wrongScore.uefa.awayGoals = 1;
  const wrongDay = fixture();
  wrongDay.uefa.day = "2026-11-04";
  const wrongTeams = fixture();
  wrongTeams.uefa.home = "Stuttgart";
  const wrongLeague = fixture();
  wrongLeague.uefa.url = wrongLeague.uefa.url.replace("uefachampionsleague", "uefaeuropaleague");
  const unfinished = fixture();
  unfinished.espn.event.status.type.completed = false;
  const future = fixture();
  future.espn.event.date = "2026-11-26T20:00Z";
  future.uefa.day = "2026-11-26";
  const wrongDate = fixture();
  wrongDate.espn.event.date = "2026-11-31T20:00Z";
  wrongDate.uefa.day = "2026-11-31";
  const malformedMatch = fixture();
  malformedMatch.espn.event.competitions = [null];
  const malformedSide = fixture();
  malformedSide.espn.event.competitions[0].competitors[0] = null;
  const result = run([wrongScore, wrongDay, wrongTeams, wrongLeague, unfinished, future, wrongDate,
    malformedMatch, malformedSide]);
  assert.equal(result.rejected.length, 9);
  assert.equal(result.staged.length, 0);
});

test("existing IDs and same-match rows under another provider are never replaced", () => {
  const byId = run([fixture()], [{ fixtureId: "espn-uefa.champions-100" }]);
  assert.equal(byId.staged.length, 0);
  assert.deepEqual(byId.existing, ["espn-uefa.champions-100"]);
  const byMatch = run([fixture()], [{
    leagueId: "2", kickoff: "2026-11-03T20:00Z", homeName: "Galatasaray", awayName: "Stuttgart",
    fixtureId: "another-provider-100", awayGoals: 4,
  }]);
  assert.equal(byMatch.staged.length, 0);
  assert.deepEqual(byMatch.existing, ["espn-uefa.champions-100"]);
});

test("both rows are withheld when two ESPN IDs claim the same UEFA fixture", () => {
  const first = fixture();
  const second = fixture();
  second.espn.event.id = "200";
  const result = run([first, second]);
  assert.equal(result.staged.length, 0);
  assert.deepEqual(result.duplicate, ["espn-uefa.champions-100", "espn-uefa.champions-200"]);
});

test("official match links support percent-encoded team names", () => {
  const candidate = fixture();
  candidate.uefa.url = "https://www.uefa.com/uefachampionsleague/match/2049614--galatasaray-vs-st%C3%BCttgart/";
  assert.equal(run([candidate]).staged.length, 1);
});

test("scheduled matches keep null scores and require both kickoff times to agree", () => {
  const candidate = fixture();
  candidate.espn.event.date = "2026-11-26T20:00Z";
  candidate.espn.event.status.type = { name: "STATUS_SCHEDULED", completed: false, state: "pre" };
  candidate.uefa = { ...candidate.uefa, status: "scheduled", day: "2026-11-26",
    kickoff: "2026-11-26T21:00:00+01:00", homeGoals: null, awayGoals: null };
  const [row] = run([candidate]).staged;
  assert.deepEqual([row.status, row.home_goals, row.away_goals], ["NS", null, null]);
  candidate.uefa.kickoff = "2026-11-26T22:00:00+01:00";
  assert.equal(run([candidate]).rejected.length, 1);
});

test("SQLite snapshot commits rows, quarantine and manifest and refuses to overwrite", () => {
  const directory = mkdtempSync(join(tmpdir(), "uefa-backfill-"));
  const path = join(directory, "isolated.sqlite");
  const candidate = fixture();
  const disputed = fixture();
  disputed.uefa.awayGoals = 5;
  const input = { candidates: [candidate, disputed], archive: [],
    before: "2026-11-22T00:00:00Z", aliases: { stuttgart: "VfB Stuttgart" } };
  try {
    const result = stageUefaBackfill(input, path);
    assert.equal(result.manifest.staged, 1);
    assert.equal(result.manifest.quarantined, 1);
    assert.match(result.manifest.sha256, /^[a-f0-9]{64}$/);
    assert.throws(() => stageUefaBackfill(input, path), { code: "EEXIST" });
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(JSON.parse(db.prepare("SELECT value FROM manifest").get().value), result.manifest);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM staged").get().n, 1);
      assert.equal(db.prepare("SELECT reason FROM quarantine").get().reason, "unverified_evidence");
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
