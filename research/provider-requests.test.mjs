import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRequests, ProviderQuotaError } from './provider-requests.mjs';

test('concurrent requests share a promise and cache stops serving at TTL', async () => {
  let now = 0;
  let loads = 0;
  const { request } = createProviderRequests({ maxRequests: 5, windowMs: 1000, now: () => now });
  const load = async () => ({ status: 200, count: ++loads });
  const first = request('archive', load, { ttlMs: 10 });
  assert.equal(first, request('archive', load, { ttlMs: 10 }));
  assert.equal((await first).count, 1);
  now = 9;
  assert.equal((await request('archive', load, { ttlMs: 10 })).count, 1);
  now = 10;
  assert.equal((await request('archive', load, { ttlMs: 10 })).count, 2);
});

test('quota and retry-after prevent outbound loads until the clock allows them', async () => {
  let now = 0;
  const { request } = createProviderRequests({ maxRequests: 1, windowMs: 100, now: () => now });
  const unexpected = () => assert.fail('Unexpected outbound call');
  await request('a', async () => ({ status: 429, retryAfterMs: 200 }));
  await assert.rejects(request('a', unexpected), ProviderQuotaError);
  now = 100;
  await assert.rejects(request('b', unexpected), ProviderQuotaError);
  now = 200;
  await assert.rejects(request('a', async () => { throw new Error('network'); }), /network/);
  now = 300;
  assert.equal((await request('a', async () => ({ status: 200 }))).status, 200);
});
