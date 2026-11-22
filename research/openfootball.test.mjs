import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenFootball } from './openfootball.mjs';

// First row of openfootball/football.json, 2015-16/en.1.json.
const match = {
  round: 'Matchday 1', date: '2015-08-08', time: '12:45',
  team1: 'Manchester United', team2: 'Tottenham Hotspur',
  score: { ht: [1, 0], ft: [1, 0] }
};
const metadata = {
  competition: 'en.1', season: '2015-16',
  sourceUrl: 'https://raw.githubusercontent.com/openfootball/football.json/master/2015-16/en.1.json'
};

test('real OpenFootball record preserves venue roles, source time and original evidence', () => {
  const { results, conflicts } = normalizeOpenFootball({ matches: [match, match] }, metadata);
  assert.equal(conflicts, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].home, 'Manchester United');
  assert.equal(results[0].away, 'Tottenham Hotspur');
  assert.equal(results[0].localTime, '12:45');
  assert.deepEqual(results[0].fullTime, [1, 0]);
  assert.deepEqual(results[0].halfTime, [1, 0]);
  assert.equal(results[0].sourceRecord, match);
});

test('conflicting same-day scores are quarantined and missing scores are excluded', () => {
  const other = { ...match, score: { ft: [0, 0] } };
  const upcoming = { ...match, date: '2015-08-09', score: null };
  const invalidDate = { ...match, date: '2015-02-30' };
  assert.deepEqual(normalizeOpenFootball({ matches: [match, other, upcoming, invalidDate] }, metadata),
    { results: [], conflicts: 1 });
});
