// Fail-closed, pure provider statistics validation. No D1 or network operations.
import { assessStatistics } from './statistics-data-quality.js';
const positiveId = x => (typeof x === 'string' || typeof x === 'number') && /^[1-9]\d*$/.test(String(x));
const canonical = x => String(x ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
export function verifyStatisticsCandidate(fixture, evidence) {
  const reject = reason => ({ state: 'rejected', reason });
  if (!fixture || !evidence || typeof fixture !== 'object' || typeof evidence !== 'object') return reject('missing_evidence');
  if (!['FT','AET','PEN','FINISHED'].includes(fixture.status)) return reject('not_final');
  if (!positiveId(fixture.home_team_id) || !positiveId(fixture.away_team_id) || String(fixture.home_team_id) === String(fixture.away_team_id)) return reject('invalid_team_ids');
  if (!fixture.source || !fixture.fixture_id || !evidence.provider || !evidence.fixture_id || !evidence.source) return reject('missing_provenance');
  if (String(evidence.source) !== String(fixture.source) || String(evidence.fixture_id) !== String(fixture.fixture_id)) return reject('fixture_or_source_mismatch');
  if (evidence.provider_verified !== true || evidence.identity_verified !== true) return reject('unverified_provenance');
  if (!Array.isArray(evidence.teams) || evidence.teams.length !== 2) return reject('two_teams_required');
  const [home, away] = evidence.teams;
  if (home?.homeAway !== 'home' || away?.homeAway !== 'away') return reject('home_away_order');
  if (String(home.team?.id) !== String(fixture.home_team_id) || String(away.team?.id) !== String(fixture.away_team_id)) return reject('team_id_mismatch');
  if (!fixture.home_team || !fixture.away_team || canonical(home.team?.name) !== canonical(fixture.home_team) || canonical(away.team?.name) !== canonical(fixture.away_team)) return reject('team_name_mismatch');
  if (evidence.kickoff !== fixture.kickoff) return reject('kickoff_mismatch');
  if (!Number.isSafeInteger(fixture.home_goals) || !Number.isSafeInteger(fixture.away_goals) || evidence.home_goals !== fixture.home_goals || evidence.away_goals !== fixture.away_goals) return reject('score_mismatch');
  const statistics = { teams: evidence.teams.map(t => ({ team: { name: t.team.name }, statistics: t.statistics })) };
  const quality = assessStatistics(statistics, { home_team: fixture.home_team, away_team: fixture.away_team, provenance_verified: true, identity_verified: true });
  if (quality.status !== 'verified_full') return reject('statistics_' + quality.status + (quality.reason ? '_' + quality.reason : ''));
  return { state: 'verified', statistics_json: JSON.stringify(statistics), provider: evidence.provider, fixture_id: fixture.fixture_id };
}
