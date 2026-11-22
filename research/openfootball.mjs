// OpenFootball dates are local calendar dates. Preserve the source time without
// adding a timezone or creating an identity match against another provider.
export function normalizeOpenFootball(payload, { competition, season, sourceUrl }) {
  if (!Array.isArray(payload?.matches) || !competition || !season || !sourceUrl) {
    throw new TypeError('Invalid OpenFootball dataset');
  }
  const records = new Map();
  const conflicts = new Set();
  const goals = value => Array.isArray(value) && value.length === 2 &&
    value.every(goal => Number.isSafeInteger(goal) && goal >= 0);
  for (const row of payload.matches) {
    const { date, time, team1, team2, score } = row ?? {};
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date ||
        typeof team1 !== 'string' || typeof team2 !== 'string') continue;
    const home = team1.normalize('NFC').trim();
    const away = team2.normalize('NFC').trim();
    if (!home || !away || home === away || !goals(score?.ft)) continue;
    const key = JSON.stringify([competition, season, date, home, away]);
    const half = goals(score.ht) && score.ht.every((goal, i) => goal <= score.ft[i])
      ? [...score.ht] : null;
    const record = {
      source: 'openfootball', sourceUrl, competition, season, date,
      localTime: typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : null,
      home, away, fullTime: [...score.ft], halfTime: half, sourceRecord: row
    };
    const prior = records.get(key);
    if (prior && (prior.localTime !== record.localTime || prior.fullTime.some((goal, i) =>
      goal !== record.fullTime[i]) || JSON.stringify(prior.halfTime) !== JSON.stringify(half))) {
      conflicts.add(key);
    }
    records.set(key, record);
  }
  for (const key of conflicts) records.delete(key);
  return { results: [...records.values()], conflicts: conflicts.size };
}
