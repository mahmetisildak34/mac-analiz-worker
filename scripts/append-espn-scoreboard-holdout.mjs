import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [destination, scoreboardDirectory, day] = process.argv.slice(2);
assert(/^\d{8}$/.test(day));
const date = [day.slice(0, 4), day.slice(4, 6), day.slice(6)].join("-");
const mappings = {
  "eng.1": ["en.1", { "Nottm Forest": "Nott'm Forest", "C Palace": "Crystal Palace", Spurs: "Tottenham" }],
  "esp.1": ["es.1", { "Alavés": "Alaves", Deportivo: "La Coruna", Rayo: "Vallecano" }],
  "ger.1": ["de.1", { Gladbach: "M'gladbach", Frankfurt: "Ein Frankfurt" }],
  "ita.1": ["it.1", { "AS Roma": "Roma" }],
  "fra.1": ["fr.1", { PSG: "Paris SG" }],
  "tur.1": ["tr.1", { "Amed SFK": "Amedspor", "Caykur Rizespor": "Rizespor" }],
};
const read = file => JSON.parse(readFileSync(file));
const save = (file, value) => writeFileSync(file, JSON.stringify(value) + "\n");
const sha = raw => createHash("sha256").update(raw).digest("hex");
const sourceFile = destination + "/benchmark-sources.json";
const sources = read(sourceFile);

for (const [slug, [league, aliases]] of Object.entries(mappings)) {
  const raw = readFileSync(scoreboardDirectory + "/" + slug + "-" + day.slice(-2) + ".json");
  const scoreboard = JSON.parse(raw);
  assert.equal(scoreboard.leagues[0].slug, slug);
  const path = destination + "/2026-27/" + league + ".json";
  const season = read(path);
  assert(!season.matches.some(match => match.date >= date), "Holdout overlaps recorded fixtures");
  const teams = new Set(season.matches.flatMap(match => [match.team1, match.team2]));
  const seen = new Set();
  const included = [];
  for (const event of scoreboard.events) {
    const [match] = event.competitions;
    if (match.status.type.completed !== true || match.status.type.name !== "STATUS_FULL_TIME") continue;
    assert.equal(event.date.slice(0, 10), date);
    assert.equal(match.id, event.id);
    assert(!seen.has(event.id), "Duplicate ESPN event");
    seen.add(event.id);
    const ordered = ["home", "away"].map(side => match.competitors.find(team => team.homeAway === side));
    const names = ordered.map(item => {
      const { displayName, shortDisplayName } = item.team;
      return aliases[shortDisplayName] ?? (teams.has(displayName) ? displayName : shortDisplayName);
    });
    assert(names.every(name => teams.has(name)), "Unknown ESPN to historical team mapping: " + names);
    assert.notEqual(names[0], names[1]);
    assert(ordered.every(item => /^[0-9]+$/.test(item.score)));
    const ft = ordered.map(item => Number(item.score));
    const summaryRaw = readFileSync(scoreboardDirectory + "/summaries/" + event.id + ".json");
    const summary = JSON.parse(summaryRaw);
    const [detail] = summary.header.competitions;
    assert.equal(summary.header.league.slug, slug);
    assert.equal(detail.id, event.id);
    assert.equal(Date.parse(detail.date), Date.parse(event.date));
    assert.equal(detail.status.type.name, "STATUS_FULL_TIME");
    const ht = ordered.map((team, i) => {
      const item = detail.competitors.find(side => side.homeAway === team.homeAway);
      assert.equal(item.team.id, team.team.id);
      assert.equal(Number(item.score), ft[i]);
      assert.equal(item.linescores.length, 2);
      const halves = item.linescores.map(half => {
        assert(/^[0-9]+$/.test(half.displayValue));
        return Number(half.displayValue);
      });
      assert.equal(halves[0] + halves[1], ft[i]);
      return halves[0];
    });
    season.matches.push({ date, team1: names[0], team2: names[1], score: { ft, ht } });
    included.push({ event_id: event.id, team_ids: ordered.map(team => team.team.id), teams: names,
      summary_url: "https://site.api.espn.com/apis/site/v2/sports/soccer/" + slug + "/summary?event=" + event.id,
      summary_sha256: sha(summaryRaw) });
  }
  save(path, season);
  sources[league + "|espn|" + day] = {
    url: "https://site.api.espn.com/apis/site/v2/sports/soccer/" + slug + "/scoreboard?dates=" + day,
    sha256: sha(raw), included,
  };
}
save(sourceFile, sources);
