export class ProviderQuotaError extends Error {}

// Instantiate once per provider and quota scope. Only public GET operations
// with canonical request keys belong here.
export function createProviderRequests({
  maxRequests, windowMs, cacheSize = 128, now = Date.now
}) {
  if (![maxRequests, windowMs, cacheSize].every(n => Number.isSafeInteger(n) && n > 0)) {
    throw new RangeError('Invalid provider limits');
  }
  const inFlight = new Map();
  const cache = new Map();
  const requestTimes = [];
  let cooldownUntil = 0;

  function request(key, load, { ttlMs = 0 } = {}) {
    const at = now();
    const saved = ttlMs > 0 ? cache.get(key) : null;
    if (saved && saved.expires > at && saved.received + ttlMs > at) return Promise.resolve(saved.value);
    if (inFlight.has(key)) return inFlight.get(key);
    while (requestTimes.length && requestTimes[0] <= at - windowMs) requestTimes.shift();
    if (at < cooldownUntil || requestTimes.length >= maxRequests) {
      return Promise.reject(new ProviderQuotaError('Provider request budget unavailable'));
    }
    requestTimes.push(at);
    const pending = Promise.resolve().then(load).then(result => {
      if (result.status === 429) {
        const delay = Number.isSafeInteger(result.retryAfterMs) && result.retryAfterMs > 0
          ? result.retryAfterMs : windowMs;
        cooldownUntil = Math.max(cooldownUntil, now() + delay);
      }
      if (result.status >= 200 && result.status < 300 && ttlMs > 0) {
        const received = now();
        cache.delete(key);
        cache.set(key, { received, expires: received + ttlMs, value: result });
        if (cache.size > cacheSize) cache.delete(cache.keys().next().value);
      }
      return result;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  }

  return { request };
}
