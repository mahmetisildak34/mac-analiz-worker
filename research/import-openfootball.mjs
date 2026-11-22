import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { normalizeOpenFootball } from './openfootball.mjs';

const competitions = ['tr.1', 'en.1', 'es.1', 'de.1', 'it.1', 'fr.1'];
const seasons = ['2024-25', '2025-26'];

export function loadOpenFootball(read, revision) {
  const sources = {};
  const leagues = {};
  for (const competition of competitions) {
    leagues[competition] = [];
    for (const season of seasons) {
      const path = `${season}/${competition}.json`;
      const bytes = read(path);
      const payload = JSON.parse(bytes.toString('utf8'));
      const sourceUrl = `https://github.com/openfootball/football.json/blob/${revision}/${path}`;
      const { results, conflicts } = normalizeOpenFootball(payload, { competition, season, sourceUrl });
      if (!results.length || conflicts) throw new Error(`Incomplete or conflicting source: ${path}`);
      sources[sourceUrl] = {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        sourceRows: payload.matches.length,
        matches: results.length,
        halfTime: results.filter(row => row.halfTime).length
      };
      leagues[competition].push(...results.map(row => ({
        fixture_id: JSON.stringify([competition, row.date, row.home, row.away]),
        kickoff: row.date, home_team: row.home, away_team: row.away,
        home_goals: row.fullTime[0], away_goals: row.fullTime[1],
        ht_home: row.halfTime?.[0] ?? null, ht_away: row.halfTime?.[1] ?? null,
        source: row.source, status: 'FT', completed: true,
        // These flags represent source-format validation inside the offline test.
        identity_verified: true, score_verified: true
      })));
    }
    leagues[competition].sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  }
  return { sources, leagues };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [, , repository, ref = 'HEAD'] = process.argv;
  const revision = execFileSync('git', ['-C', repository, 'rev-parse', '--verify', ref + '^{commit}'], {
    encoding: 'utf8'
  }).trim();
  console.log(JSON.stringify(loadOpenFootball(path =>
    execFileSync('git', ['-C', repository, 'show', revision + ':' + path]), revision)));
}
