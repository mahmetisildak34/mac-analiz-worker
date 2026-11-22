// Only date-level final scores can fall back to OpenFootball. Exact kickoff,
// live status and other match details require the primary provider.
export function resolveArchiveScore({ fixture, primary, alternatives, aliases = new Map() }) {
  const name = value => typeof value === 'string' ? value.normalize('NFC').trim().toLowerCase() : '';
  const canonical = value => aliases.get(name(value)) ?? name(value);
  const validTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (fixture?.status !== 'FT' || !fixture.competition || !fixture.season ||
      typeof fixture.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fixture.date) ||
      (fixture.localTime != null && !validTime(fixture.localTime)) ||
      !canonical(fixture.home) || !canonical(fixture.away) ||
      canonical(fixture.home) === canonical(fixture.away)) return { state: 'unsupported' };

  const valid = score => Array.isArray(score) && score.length === 2 &&
    score.every(value => Number.isSafeInteger(value) && value >= 0);
  const matches = (Array.isArray(alternatives) ? alternatives : []).filter(row =>
    row?.source === 'openfootball' && row.sourceUrl && row.sourceRecord &&
    row.competition === fixture.competition && row.season === fixture.season &&
    row.date === fixture.date && canonical(row.home) === canonical(fixture.home) &&
    canonical(row.away) === canonical(fixture.away) && valid(row.fullTime));
  if (matches.length > 1) return { state: 'ambiguous' };
  const alternative = matches[0];
  if (alternative && fixture.localTime != null && alternative.localTime !== fixture.localTime) {
    return { state: 'time-conflict', alternative };
  }
  if (primary?.state === 'ok' && valid(primary.fullTime)) {
    if (alternative && primary.fullTime.some((goal, i) => goal !== alternative.fullTime[i])) {
      return { state: 'conflict', primary, alternative };
    }
    return { state: 'ok', record: primary };
  }
  if (['unavailable', 'missing'].includes(primary?.state) && alternative) {
    return { state: 'ok', record: alternative };
  }
  return { state: 'unavailable' };
}

// The callers own transport and credentials. Both sources must return normalized
// public archive records before this function can resolve a score.
export async function getArchiveScore({
  fixture, aliases, primaryRequests, archiveRequests, primaryKey, archiveKey,
  loadPrimary, loadArchive, archiveTtlMs, auditPrimary = false
}) {
  const preflight = resolveArchiveScore({ fixture, aliases });
  if (preflight.state === 'unsupported') return preflight;
  let primary;
  try {
    const response = await primaryRequests.request(primaryKey, loadPrimary);
    if (response.status === 401 || response.status === 403) return { state: 'unauthorized' };
    if (response.status === 404) primary = { state: 'missing' };
    else if (response.status === 429 || response.status >= 500) primary = { state: 'unavailable' };
    else if (response.status >= 200 && response.status < 300) {
      primary = response.record ? { ...response.record, state: 'ok' } : { state: 'missing' };
    } else return { state: 'invalid-primary' };
  } catch {
    primary = { state: 'unavailable' };
  }

  let alternatives = [];
  if (primary.state !== 'ok' || auditPrimary) {
    try {
      const response = await archiveRequests.request(archiveKey, loadArchive, { ttlMs: archiveTtlMs });
      if (response.status === 200) alternatives = response.results;
    } catch {
      // The primary record remains usable when the independent archive is down.
    }
  }
  return resolveArchiveScore({ fixture, aliases, primary, alternatives });
}
