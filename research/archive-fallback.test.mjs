import test from 'node:test';
import assert from 'node:assert/strict';
import { getArchiveScore, resolveArchiveScore } from './archive-fallback.mjs';
import { normalizeOpenFootball } from './openfootball.mjs';
import { createProviderRequests } from './provider-requests.mjs';

const metadata = {
  competition: 'en.1', season: '2015-16',
  sourceUrl: 'https://raw.githubusercontent.com/openfootball/football.json/master/2015-16/en.1.json'
};
const original = {
  date: '2015-08-08', time: '12:45', team1: 'Manchester United', team2: 'Tottenham Hotspur',
  score: { ht: [1, 0], ft: [1, 0] }
};
const [alternative] = normalizeOpenFootball({ matches: [original] }, metadata).results;
const fixture = {
  ...metadata, status: 'FT', date: original.date, localTime: original.time,
  home: 'Man United', away: 'Tottenham Hotspur'
};
const request = {
  fixture, primary: { state: 'unavailable' }, alternatives: [alternative],
  aliases: new Map([['man united', 'manchester united']])
};

test('falls back only with explicit alias and matching historical venue identities', () => {
  assert.deepEqual(resolveArchiveScore(request), { state: 'ok', record: alternative });
  assert.equal(resolveArchiveScore({ ...request, aliases: undefined }).state, 'unavailable');
  assert.equal(resolveArchiveScore({ ...request, fixture: { ...fixture, date: '2015-08-09' } }).state, 'unavailable');
  assert.equal(resolveArchiveScore({ ...request, fixture: { ...fixture, home: fixture.away, away: fixture.home } }).state, 'unavailable');
  assert.equal(resolveArchiveScore({ ...request, fixture: { ...fixture, status: 'LIVE' } }).state, 'unsupported');
});

test('blocks multiple matches and flags score conflicts', () => {
  assert.equal(resolveArchiveScore({ ...request, alternatives: [alternative, alternative] }).state, 'ambiguous');
  assert.equal(resolveArchiveScore({ ...request, fixture: { ...fixture, localTime: '15:00' } }).state, 'time-conflict');
  const primary = { state: 'ok', fullTime: [0, 0] };
  assert.deepEqual(resolveArchiveScore({ ...request, primary }), { state: 'conflict', primary, alternative });
  assert.equal(resolveArchiveScore({ ...request, primary: { state: 'unauthorized' } }).state, 'unavailable');
});

test('source orchestration coalesces archive reads during a primary outage', async () => {
  const config = { maxRequests: 2, windowMs: 1000 };
  let primaryCalls = 0;
  let archiveCalls = 0;
  const options = {
    fixture, aliases: request.aliases,
    primaryRequests: createProviderRequests(config), archiveRequests: createProviderRequests(config),
    primaryKey: 'fixture', archiveKey: 'en.1/2015-16', archiveTtlMs: 1000,
    loadPrimary: async () => { primaryCalls++; return { status: 503 }; },
    loadArchive: async () => { archiveCalls++; return { status: 200, results: [alternative] }; }
  };
  const results = await Promise.all([getArchiveScore(options), getArchiveScore(options)]);
  assert.deepEqual(results, Array(2).fill({ state: 'ok', record: alternative }));
  assert.equal(primaryCalls, 1);
  assert.equal(archiveCalls, 1);
  const denied = await getArchiveScore({ ...options, loadPrimary: async () => ({ status: 403 }) });
  assert.deepEqual(denied, { state: 'unauthorized' });
  assert.equal(archiveCalls, 1);
});
