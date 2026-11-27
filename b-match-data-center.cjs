"use strict";
const TeamIdentity = require("./b-team-identity-registry.cjs");
const MIN_HISTORY = 10;
const DATA_CENTER_CRON_UTC = "1 21 * * *"; // 00:01 Turkey time (UTC+3).
const validDate = value => Number.isFinite(Date.parse(value));
const isScore = value => Number.isInteger(value) && value >= 0;
const eventKey = row => `${String(row.provider || "").trim().toLowerCase()}:${String(row.providerFixtureId || row.fixtureId || "").trim()}`;
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function contentHash(value) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
function safeStats(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(item => item && item.verified === true && item.provider && item.name &&
    (Number.isFinite(item.value) || typeof item.value === "string") &&
    (typeof item.value !== "number" || item.value >= 0))
    // Keep the per-value verification marker: the app consumer only accepts
    // statistics that carry it, so dropping it here would silently empty the
    // prepared statistics even when the source verified them.
    .map(item => ({ name: String(item.name), value: item.value, unit: item.unit || null,
      provider: String(item.provider), source: item.source || null, verified: true }));
}
function validateHistory(rawRows, beforeDate) {
  const unique = new Map(), conflicts = new Set();
  for (const row of rawRows || []) {
    if (!row || row.status !== "completed" || row.verified !== true || !row.provider || !row.providerFixtureId || !validDate(row.kickoff) ||
        Date.parse(row.kickoff) >= Date.parse(beforeDate) || !isScore(row.homeScore) || !isScore(row.awayScore) ||
        !row.homeTeamId || !row.awayTeamId || row.homeTeamId === row.awayTeamId || !eventKey(row).includes(":")) continue;
    const providerKey = eventKey(row);
    const normalizedDay = new Date(Date.parse(row.kickoff)).toISOString().slice(0, 10);
    const key = `${normalizedDay}:${String(row.homeTeamId).trim()}:${String(row.awayTeamId).trim()}`;
    if (unique.has(key)) {
      const previous = unique.get(key);
      if (previous.homeScore !== row.homeScore || previous.awayScore !== row.awayScore) {
        unique.delete(key); conflicts.add(key);
      }
      continue;
    }
    if (!conflicts.has(key)) unique.set(key, { ...row, canonicalHistoryKey: key, providerHistoryKey: providerKey });
  }
  return { matches: [...unique.values()].sort((a,b) => Date.parse(b.kickoff) - Date.parse(a.kickoff)), conflicts: [...conflicts] };
}
function summarize(teamId, identity, cutoffDate, history) {
  const lastTen = history.slice(0, MIN_HISTORY).map(row => {
    const isHome = row.homeTeamId === teamId;
    const goalsFor = isHome ? row.homeScore : row.awayScore;
    const goalsAgainst = isHome ? row.awayScore : row.homeScore;
    const halftime = row.halftime && isScore(row.halftime.homeScore) && isScore(row.halftime.awayScore)
      ? { homeScore: row.halftime.homeScore, awayScore: row.halftime.awayScore, provider: row.halftime.provider || row.provider }
      : null;
    return { archiveRef: eventKey(row), kickoff: row.kickoff, competitionId: String(row.competitionId || ""),
      opponentTeamId: isHome ? row.awayTeamId : row.homeTeamId, venue: isHome ? "home" : "away",
      goalsFor, goalsAgainst, halftime, statistics: safeStats(row.statistics),
      verificationSource: row.verificationSource || null };
  });
  const metricCounts = {};
  let matchesWithVerifiedStatistics = 0;
  for (const match of lastTen) {
    if (match.statistics.length) matchesWithVerifiedStatistics++;
    for (const stat of match.statistics) {
      const key = stat.name.trim().toLowerCase();
      metricCounts[key] = (metricCounts[key] || 0) + 1;
    }
  }
  const calc = rows => rows.reduce((s,row) => {
    s.played++;
    s.wins += Number(row.goalsFor > row.goalsAgainst);
    s.draws += Number(row.goalsFor === row.goalsAgainst);
    s.losses += Number(row.goalsFor < row.goalsAgainst);
    s.goalsFor += row.goalsFor; s.goalsAgainst += row.goalsAgainst;
    return s;
  }, { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0 });
  return { teamId, currentName: identity.names.find(n => n.nameType === "current" && (n.verified === true || n.verified === 1))?.displayName || null,
    verifiedNames: (identity.names || []).filter(n => n.verified === true || n.verified === 1).map(n => n.displayName),
    verifiedProviderIds: (identity.providerIds || []).filter(n => n.verified === true || n.verified === 1).map(n => ({ provider: n.provider, providerTeamId: n.providerTeamId })),
    cutoffDate, historyCount: lastTen.length, history: lastTen, form: calc(lastTen),
    statisticsCoverage: { historyMatches: lastTen.length, matchesWithVerifiedStatistics,
      matchesWithoutVerifiedStatistics: lastTen.length - matchesWithVerifiedStatistics, verifiedMetricCounts: metricCounts },
    home: calc(lastTen.filter(m => m.venue === "home")), away: calc(lastTen.filter(m => m.venue === "away")) };
}

/** Build only analysis-ready records. Incomplete fixtures are quarantined from the consumer B view. */
function prepareDataCenter(input) {
  const expectedCompetitions = [...new Set((input?.expectedCompetitionIds || []).map(String))].sort();
  const loadedCompetitions = [...new Set((input?.loadedCompetitionIds || []).map(String))].sort();
  if (!input || input.scopeComplete !== true || expectedCompetitions.length === 0 ||
      expectedCompetitions.length !== loadedCompetitions.length ||
      expectedCompetitions.some((id,index) => id !== loadedCompetitions[index]))
    throw new Error("Every supported competition must be confirmed loaded before preparing a B generation.");
  const generatedAt = input.generatedAt || new Date().toISOString();
  if (!validDate(generatedAt)) throw new TypeError("generatedAt must be a valid timestamp.");
  const identities = input.identities || [];
  const records = new Map(), fixtureKeys = new Set(), quarantined = [];
  for (const fixture of input.fixtures || []) {
    const key = eventKey(fixture);
    const reject = reason => quarantined.push({ fixtureKey: key, reason });
    if (!key || key.endsWith(":")) { reject("missing_fixture_identity"); continue; }
    if (fixtureKeys.has(key)) { reject("duplicate_fixture"); continue; }
    fixtureKeys.add(key);
    if (!validDate(fixture.kickoff) || !["scheduled", "live", "completed"].includes(fixture.status)) { reject("invalid_fixture_status_or_date"); continue; }
    const resolved = {};
    let unresolved = false;
    for (const side of ["home", "away"]) {
      const candidate = fixture[side] || {};
      const match = TeamIdentity.resolveIdentity({ provider: candidate.provider || fixture.provider,
        providerTeamId: candidate.providerTeamId, name: candidate.name, countryCode: candidate.countryCode,
        competitionId: fixture.competitionId, eventDate: fixture.kickoff }, identities);
      if (match.status !== "matched") { reject(`${side}_identity_${match.status}`); unresolved = true; break; }
      const identity = identities.find(item => item.teamId === match.teamId);
      if (!identity) { reject(`${side}_identity_missing`); unresolved = true; break; }
      resolved[side] = { teamId: match.teamId, identity };
    }
    if (unresolved) continue;
    if (resolved.home.teamId === resolved.away.teamId) { reject("same_canonical_team_both_sides"); continue; }
    const teamAnalysisKeys = {}, pendingAnalyses = new Map();
    let insufficient = false;
    for (const side of ["home", "away"]) {
      const teamId = resolved[side].teamId;
      const checked = validateHistory(input.historiesByTeam?.[teamId], fixture.kickoff);
      if (checked.conflicts.length) { reject(`${side}_history_conflict`); insufficient = true; break; }
      if (checked.matches.length < MIN_HISTORY) { reject(`${side}_history_below_10`); insufficient = true; break; }
      const cutoffDate = new Date(Date.parse(fixture.kickoff)).toISOString().slice(0, 10);
      const analysisKey = `team-analysis:${teamId}:${cutoffDate}`;
      teamAnalysisKeys[side] = analysisKey;
      if (!records.has(analysisKey) && !pendingAnalyses.has(analysisKey)) {
        const payload = summarize(teamId, resolved[side].identity, cutoffDate, checked.matches);
        if (payload.historyCount !== MIN_HISTORY) { reject(`${side}_history_not_exactly_10`); insufficient = true; break; }
        pendingAnalyses.set(analysisKey, { key: analysisKey, kind: "team_analysis", readiness: "analysis_ready", payload });
      }
    }
    if (insufficient) continue;
    const fixturePayload = { fixtureKey: key, provider: fixture.provider, providerFixtureId: String(fixture.providerFixtureId || fixture.fixtureId),
      competitionId: String(fixture.competitionId || ""), kickoff: fixture.kickoff, status: fixture.status,
      home: { teamId: resolved.home.teamId, currentName: resolved.home.identity.names.find(n => n.nameType === "current" && n.verified)?.displayName || null },
      away: { teamId: resolved.away.teamId, currentName: resolved.away.identity.names.find(n => n.nameType === "current" && n.verified)?.displayName || null },
      teamAnalysisKeys, statistics: safeStats(input.statisticsByFixture?.[key]) };
    if ((fixture.status === "live" || fixture.status === "completed") &&
        (!isScore(fixture.homeScore) || !isScore(fixture.awayScore) || fixture.scoreVerified !== true)) {
      reject("unverified_current_score");
      continue;
    }
    if (isScore(fixture.homeScore) && isScore(fixture.awayScore) && fixture.scoreVerified === true) {
      fixturePayload.score = { home: fixture.homeScore, away: fixture.awayScore, verified: true, source: fixture.scoreSource || fixture.provider };
    }
    for (const [key, row] of pendingAnalyses) if (!records.has(key)) records.set(key, row);
    const fixtureRecordKey = `fixture:${key}`;
    records.set(fixtureRecordKey, { key: fixtureRecordKey, kind: "fixture", readiness: "analysis_ready", payload: fixturePayload });
  }
  return { generatedAt, sourceWatermark: input.sourceWatermark || null, scopeComplete: true,
    expectedCompetitionIds: expectedCompetitions, records: [...records.values()], quarantined,
    fixtureCount: fixtureKeys.size, readyFixtures: [...records.values()].filter(row => row.kind === "fixture").length,
    readyTeams: new Set([...records.values()].filter(row => row.kind === "team_analysis").map(row => row.payload.teamId)).size,
    minimumHistory: MIN_HISTORY };
}

/** Atomically publish a full B view. The adapter must implement rollback-capable atomicCommit. */
async function publishDataCenter(adapter, batch) {
  if (!batch || batch.scopeComplete !== true) throw new Error("Incomplete B snapshot refused; active generation is unchanged.");
  if (typeof adapter?.loadActiveItems !== "function" || typeof adapter?.atomicCommit !== "function")
    throw new TypeError("A read adapter and rollback-capable atomicCommit adapter are required.");
  const active = await adapter.loadActiveItems();
  const current = Array.isArray(active) ? active : (active?.items || []);
  const oldByKey = new Map(current.map(item => [item.key, item.hash]));
  const candidateByKey = new Map((batch.records || []).map(row => [row.key, row]));
  const quarantineKeys = new Set((batch.quarantined || []).map(row => row.fixtureKey).filter(Boolean));
  let preservedPrevious = 0;
  for (const old of current) {
    if (old.kind !== "fixture" || !quarantineKeys.has(String(old.key).replace(/^fixture:/, "")) || candidateByKey.has(old.key)) continue;
    if (!old.payload) throw new Error("Quarantined fixture cannot be safely retained without its previous verified payload.");
    candidateByKey.set(old.key, { key: old.key, kind: old.kind, readiness: old.readiness, payload: old.payload });
    preservedPrevious++;
    for (const analysisKey of Object.values(old.payload.teamAnalysisKeys || {})) {
      if (candidateByKey.has(analysisKey)) continue;
      const analysis = current.find(item => item.key === analysisKey);
      if (!analysis?.payload) throw new Error("Previous team-analysis payload is unavailable; active generation is unchanged.");
      candidateByKey.set(analysis.key, { key: analysis.key, kind: analysis.kind, readiness: analysis.readiness, payload: analysis.payload });
    }
  }
  if (![...candidateByKey.values()].some(row => row.kind === "fixture" && row.readiness === "analysis_ready"))
    throw new Error("No analysis-ready fixture exists; active generation is unchanged.");
  const newItems = await Promise.all([...candidateByKey.values()].map(async row => ({ key: row.key, kind: row.kind, readiness: row.readiness,
    payload: row.payload, hash: await contentHash(row.payload) })));
  const newByKey = new Map(newItems.map(item => [item.key, item.hash]));
  const changes = { inserted: 0, updated: 0, unchanged: 0, removed: 0 };
  for (const item of newItems) {
    if (!oldByKey.has(item.key)) changes.inserted++;
    else if (oldByKey.get(item.key) === item.hash) changes.unchanged++;
    else changes.updated++;
  }
  changes.removed = [...oldByKey.keys()].filter(key => !newByKey.has(key)).length;
  const sourceWatermark = batch.sourceWatermark || null;
  if (active?.generationId && changes.inserted === 0 && changes.updated === 0 && changes.removed === 0 &&
      (active.manifest?.sourceWatermark || null) === sourceWatermark) {
    return { generationId: active.generationId, changes, readyFixtures: newItems.filter(row => row.kind === "fixture").length,
      quarantined: batch.quarantined || [], preservedPrevious, noOp: true };
  }
  const readyFixtures = newItems.filter(row => row.kind === "fixture").length;
  const manifest = { generatedAt: batch.generatedAt, recordCount: newItems.length, readyFixtures,
    minimumHistory: MIN_HISTORY, scopeComplete: true, expectedCompetitionIds: batch.expectedCompetitionIds,
    sourceWatermark,
    digest: await contentHash(newItems.map(({key,hash}) => ({key,hash}))) };
  const generationId = `${Date.parse(batch.generatedAt)}:${manifest.digest.slice(0,12)}:${globalThis.crypto.randomUUID()}`;
  await adapter.atomicCommit({ generationId, manifest, items: newItems, changes });
  return { generationId, changes, readyFixtures, quarantined: batch.quarantined || [], preservedPrevious };
}

/** Realtime updates are a separate overlay: no inferred clock, unverified score or statistics are accepted. */
async function applyLiveUpdate(adapter, update) {
  if (!update || update.providerVerified !== true || !update.provider || !update.fixtureKey ||
      !["live", "completed"].includes(update.status) || !validDate(update.observedAt) ||
      !isScore(update.homeScore) || !isScore(update.awayScore))
    return { accepted: false, reason: "invalid_or_unverified_live_update" };
  let elapsedSeconds = null;
  if (update.clockPrecise === true) {
    if (!Number.isInteger(update.elapsedSeconds) || update.elapsedSeconds < 0) return { accepted: false, reason: "invalid_precise_clock" };
    elapsedSeconds = update.elapsedSeconds;
  }
  const minuteLabel = typeof update.minuteLabel === "string" && update.minuteLabel.trim() ? update.minuteLabel.trim() : null;
  const normalized = { fixtureKey: update.fixtureKey, provider: update.provider, status: update.status,
    observedAt: update.observedAt, homeScore: update.homeScore, awayScore: update.awayScore,
    minuteLabel, elapsedSeconds, clockPrecise: elapsedSeconds !== null,
    statistics: safeStats(update.statistics) };
  if (typeof adapter?.applyLiveOverlay !== "function") throw new TypeError("A live-overlay adapter is required.");
  const result = await adapter.applyLiveOverlay(normalized);
  return result?.accepted ? { accepted: true, normalized } : { accepted: false, reason: result?.reason || "stale_update" };
}

module.exports = { MIN_HISTORY, DATA_CENTER_CRON_UTC, prepareDataCenter, publishDataCenter, applyLiveUpdate, contentHash, validateHistory, safeStats };
