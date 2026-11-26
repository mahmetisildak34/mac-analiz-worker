"use strict";

// Isolated Stage 4 integration adapter. Not imported by worker.js and not enabled
// by wrangler.jsonc. Production use requires separately approved D1 migrations.
const DAILY_B_CRON_UTC = "1 21 * * *";
const FINAL_STATUSES = new Set(["FT", "AET", "PEN", "COMPLETED", "FINISHED", "FULL TIME"]);
const safeJson = value => { try { return value ? JSON.parse(value) : null; } catch (_) { return null; } };
const hasScore = value => Number.isInteger(value) && value >= 0;

function createWorkerBLayer({ DB, core, identityApi, now = () => new Date().toISOString() }) {
  if (!DB || !core || typeof core.prepareDataCenter !== "function" ||
      typeof core.publishDataCenter !== "function" || typeof identityApi?.resolveIdentity !== "function") {
    throw new TypeError("D1, the B core, and the team identity resolver are required.");
  }
  let expectedActiveId = null;

  async function rows(sql, ...values) {
    let statement = DB.prepare(sql);
    if (values.length) statement = statement.bind(...values);
    const result = await statement.all();
    return Array.isArray(result?.results) ? result.results : [];
  }
  async function row(sql, ...values) {
    let statement = DB.prepare(sql);
    if (values.length) statement = statement.bind(...values);
    if (typeof statement.first === "function") return statement.first();
    return (await rows(sql, ...values))[0] || null;
  }

  async function loadIdentities() {
    const [teams, names, providerIds, review] = await Promise.all([
      rows("SELECT team_id, country_code, lifecycle_status FROM mam_team_identities"),
      rows("SELECT team_id, display_name, normalized_name, name_type, verified, valid_from, valid_to FROM mam_team_names WHERE verified=1"),
      rows("SELECT team_id, provider, provider_team_id, verified, valid_from, valid_to FROM mam_team_provider_ids WHERE verified=1"),
      rows("SELECT provider, provider_team_id, raw_name, normalized_name, country_code, competition_id, suggested_team_id, status FROM mam_team_identity_review_queue WHERE status='pending'")
    ]);
    const nameByTeam = new Map(), idByTeam = new Map();
    for (const item of names) {
      const list = nameByTeam.get(item.team_id) || [];
      list.push({ displayName: item.display_name, normalizedName: item.normalized_name, nameType: item.name_type,
        verified: item.verified, validFrom: item.valid_from, validTo: item.valid_to });
      nameByTeam.set(item.team_id, list);
    }
    for (const item of providerIds) {
      const list = idByTeam.get(item.team_id) || [];
      list.push({ provider: item.provider, providerTeamId: item.provider_team_id, verified: item.verified,
        validFrom: item.valid_from, validTo: item.valid_to });
      idByTeam.set(item.team_id, list);
    }
    return {
      identities: teams.map(team => ({ teamId: team.team_id, countryCode: team.country_code,
        names: nameByTeam.get(team.team_id) || [], providerIds: idByTeam.get(team.team_id) || [] })),
      reviewCandidates: review.map(item => ({ provider: item.provider, providerTeamId: item.provider_team_id,
        rawName: item.raw_name, normalizedName: item.normalized_name, countryCode: item.country_code,
        competitionId: item.competition_id, suggestedTeamId: item.suggested_team_id, status: item.status }))
    };
  }

  // Query only history with two persisted, approved side-to-team links. There is
  // intentionally no league filter: a canonical team can use verified history
  // from any competition. The team/date link index bounds each per-team read.
  async function loadHistoryForTeam(teamId, before) {
    const sql = `
      SELECT DISTINCT m.source, m.fixture_id, m.league_id, m.kickoff, m.status,
             m.home_goals, m.away_goals, m.statistics_json, m.raw_json,
             h.team_id AS canonical_home_team_id, a.team_id AS canonical_away_team_id
      FROM mam_team_match_links selected
      JOIN matches m ON m.source=selected.provider AND m.fixture_id=selected.provider_fixture_id
      JOIN mam_team_match_links h ON h.provider=m.source AND h.provider_fixture_id=m.fixture_id AND h.side='home'
      JOIN mam_team_match_links a ON a.provider=m.source AND a.provider_fixture_id=m.fixture_id AND a.side='away'
      WHERE selected.team_id=? AND selected.side='home' AND selected.match_date < substr(?,1,10)
        AND m.kickoff < ? AND upper(m.status) IN ('FT','AET','PEN','COMPLETED','FINISHED','FULL TIME')
        AND m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL
      UNION
      SELECT DISTINCT m.source, m.fixture_id, m.league_id, m.kickoff, m.status,
             m.home_goals, m.away_goals, m.statistics_json, m.raw_json,
             h.team_id AS canonical_home_team_id, a.team_id AS canonical_away_team_id
      FROM mam_team_match_links selected
      JOIN matches m ON m.source=selected.provider AND m.fixture_id=selected.provider_fixture_id
      JOIN mam_team_match_links h ON h.provider=m.source AND h.provider_fixture_id=m.fixture_id AND h.side='home'
      JOIN mam_team_match_links a ON a.provider=m.source AND a.provider_fixture_id=m.fixture_id AND a.side='away'
      WHERE selected.team_id=? AND selected.side='away' AND selected.match_date < substr(?,1,10)
        AND m.kickoff < ? AND upper(m.status) IN ('FT','AET','PEN','COMPLETED','FINISHED','FULL TIME')
        AND m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL
      ORDER BY kickoff DESC LIMIT 100`;
    const found = await rows(sql, teamId, before, before, teamId, before, before);
    return found.filter(item => hasScore(Number(item.home_goals)) && hasScore(Number(item.away_goals)))
      .map(item => {
        const raw = safeJson(item.raw_json);
        const rawHalf = raw?.score?.halftime || raw?.score?.halfTime || raw?.halftime || null;
        const halfHome = rawHalf?.homeScore ?? rawHalf?.home;
        const halfAway = rawHalf?.awayScore ?? rawHalf?.away;
        const halftime = hasScore(Number(halfHome)) && hasScore(Number(halfAway))
          ? { homeScore: Number(halfHome), awayScore: Number(halfAway), provider: String(item.source) } : null;
        const stats = safeJson(item.statistics_json);
        // Statistics are passed through only when the source stored explicit
        // per-value verification; the core applies its own verified filter too.
        const statistics = Array.isArray(stats) ? stats.filter(value => value?.verified === true) : [];
        return { provider: String(item.source), providerFixtureId: String(item.fixture_id),
          kickoff: item.kickoff, competitionId: String(item.league_id),
          homeTeamId: item.canonical_home_team_id, awayTeamId: item.canonical_away_team_id,
          homeScore: Number(item.home_goals), awayScore: Number(item.away_goals),
          status: "completed", verified: true, halftime, statistics };
      });
  }

  async function loadActiveItems() {
    const active = await row(`SELECT g.generation_id, g.manifest_json FROM mam_b_active_generation a
      JOIN mam_b_generations g ON g.generation_id=a.generation_id WHERE a.singleton=1`);
    expectedActiveId = active?.generation_id || null;
    if (!expectedActiveId) return { generationId: null, manifest: null, items: [] };
    const items = await rows(`SELECT i.item_key AS key, i.item_kind AS kind, i.readiness,
        p.payload_hash AS hash, p.payload_json FROM mam_b_generation_items i
      JOIN mam_b_payloads p ON p.payload_hash=i.payload_hash WHERE i.generation_id=?`, expectedActiveId);
    return { generationId: expectedActiveId, manifest: safeJson(active.manifest_json),
      items: items.map(item => ({ ...item, payload: safeJson(item.payload_json) })) };
  }

  async function atomicCommit({ generationId, manifest, items }) {
    const createdAt = manifest.generatedAt || now();
    const writeBatch = async statements => { if (statements.length) await DB.batch(statements); };
    const bound = (sql, ...values) => DB.prepare(sql).bind(...values);
    await writeBatch([bound("INSERT INTO mam_b_generations(generation_id,created_at,status,manifest_json) VALUES(?,?,'staging',?)",
      generationId, createdAt, JSON.stringify(manifest))]);
    try {
      // Stage in bounded D1 batches. Readers still see the old active pointer;
      // promotion is a separate compare-and-swap transaction at the end.
      for (let start = 0; start < items.length; start += 25) {
        const batch = [];
        for (const item of items.slice(start, start + 25)) {
          batch.push(bound("INSERT OR IGNORE INTO mam_b_payloads(payload_hash,payload_json,created_at) VALUES(?,?,?)",
            item.hash, JSON.stringify(item.payload), createdAt));
          batch.push(bound("INSERT INTO mam_b_generation_items(generation_id,item_key,item_kind,readiness,payload_hash) VALUES(?,?,?,'analysis_ready',?)",
            generationId, item.key, item.kind, item.hash));
        }
        await writeBatch(batch);
      }
      const expected = expectedActiveId;
      await writeBatch([
        bound(`UPDATE mam_b_generations SET status='retired' WHERE status='active' AND generation_id=(
          SELECT generation_id FROM mam_b_active_generation WHERE singleton=1 AND generation_id IS ?)` , expected),
        bound(`UPDATE mam_b_generations SET status='active' WHERE generation_id=? AND status='staging' AND (
          (? IS NULL AND NOT EXISTS(SELECT 1 FROM mam_b_active_generation WHERE singleton=1)) OR
          EXISTS(SELECT 1 FROM mam_b_active_generation WHERE singleton=1 AND generation_id=?))`, generationId, expected, expected),
        bound(`INSERT INTO mam_b_active_generation(singleton,generation_id,updated_at) VALUES(1,?,?)
          ON CONFLICT(singleton) DO UPDATE SET generation_id=excluded.generation_id,updated_at=excluded.updated_at
          WHERE mam_b_active_generation.generation_id IS ?`, generationId, createdAt, expected)
      ]);
      const active = await row("SELECT generation_id FROM mam_b_active_generation WHERE singleton=1");
      if (active?.generation_id !== generationId) throw new Error("stale_generation_compare_and_swap");
      expectedActiveId = generationId;
    } catch (error) {
      try { await writeBatch([bound("UPDATE mam_b_generations SET status='failed',failure_reason=? WHERE generation_id=? AND status='staging'",
        String(error?.message || error).slice(0, 300), generationId)]); } catch (_) {}
      throw error;
    }
  }

  const storageAdapter = { loadActiveItems, atomicCommit,
    async applyLiveOverlay(update) {
      const result = await DB.prepare(`INSERT INTO mam_b_live_overlay
        (fixture_key,provider,status,observed_at,home_score,away_score,minute_label,elapsed_seconds,clock_precise,statistics_json)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS(
          SELECT 1 FROM mam_b_active_generation g JOIN mam_b_generation_items i ON i.generation_id=g.generation_id
          WHERE g.singleton=1 AND i.item_key=? AND i.item_kind='fixture')
        ON CONFLICT(fixture_key) DO UPDATE SET provider=excluded.provider,status=excluded.status,observed_at=excluded.observed_at,
          home_score=excluded.home_score,away_score=excluded.away_score,minute_label=excluded.minute_label,
          elapsed_seconds=excluded.elapsed_seconds,clock_precise=excluded.clock_precise,statistics_json=excluded.statistics_json
        WHERE excluded.observed_at>mam_b_live_overlay.observed_at`)
        .bind(update.fixtureKey, update.provider, update.status, update.observedAt, update.homeScore, update.awayScore,
          update.minuteLabel, update.elapsedSeconds, Number(update.clockPrecise), JSON.stringify(update.statistics), `fixture:${update.fixtureKey}`).run();
      return { accepted: Number(result?.meta?.changes || 0) > 0, reason: "stale_or_fixture_not_active" };
    }
  };

  async function prepareByCompetition(input) {
    const expected = [...new Set((input?.expectedCompetitionIds || []).map(String))].sort();
    if (!expected.length) throw new Error("Expected competition scope is empty.");
    const loaded = new Set((input.loadedCompetitionIds || []).map(String));
    const active = await loadActiveItems();
    const identitiesResult = await loadIdentities();
    const identityRows = identitiesResult.identities;
    const records = new Map(), quarantined = [], outcomes = [];
    const fixtureList = input.fixtures || [];
    const loadErrors = input.competitionLoadErrors || {};

    for (const competitionId of expected) {
      if (!loaded.has(competitionId) || loadErrors[competitionId]) {
        outcomes.push({ competitionId, status: "preserved_previous", reason: loadErrors[competitionId] || "source_scope_not_loaded" });
        continue;
      }
      try {
        const fixtures = fixtureList.filter(fixture => String(fixture.competitionId || "") === competitionId);
        const teamIds = new Set();
        const cutoffByTeam = new Map();
        for (const fixture of fixtures) {
          for (const side of ["home", "away"]) {
            const candidate = fixture[side] || {};
            const resolved = identityApi.resolveIdentity({ provider: candidate.provider || fixture.provider,
              providerTeamId: candidate.providerTeamId, name: candidate.name, countryCode: candidate.countryCode,
              competitionId, eventDate: fixture.kickoff }, identityRows, identitiesResult.reviewCandidates);
            if (resolved.status !== "matched") continue;
            teamIds.add(resolved.teamId);
            const previous = cutoffByTeam.get(resolved.teamId);
            if (!previous || Date.parse(fixture.kickoff) > Date.parse(previous)) cutoffByTeam.set(resolved.teamId, fixture.kickoff);
          }
        }
        const historiesByTeam = {};
        for (const teamId of teamIds) historiesByTeam[teamId] = await loadHistoryForTeam(teamId, cutoffByTeam.get(teamId));
        const batch = core.prepareDataCenter({ ...input, expectedCompetitionIds: [competitionId], loadedCompetitionIds: [competitionId],
          identities: identityRows, reviewCandidates: identitiesResult.reviewCandidates,
          fixtures, historiesByTeam, scopeComplete: true });
        for (const item of batch.records) records.set(item.key, item);
        quarantined.push(...batch.quarantined);
        outcomes.push({ competitionId, status: "loaded", fixtureCount: batch.fixtureCount,
          readyFixtures: batch.readyFixtures, quarantined: batch.quarantined.length });
      } catch (error) {
        outcomes.push({ competitionId, status: "preserved_previous", reason: String(error?.message || error).slice(0, 250) });
      }
    }

    // Keep the last verified bundle for any competition whose A/source read failed.
    // This lets healthy competition scopes proceed without dropping failed-scope data.
    const failed = new Set(outcomes.filter(item => item.status === "preserved_previous").map(item => item.competitionId));
    const oldByKey = new Map(active.items.map(item => [item.key, item]));
    const preservedAnalysisKeys = new Set();
    for (const item of active.items) {
      if (item.kind !== "fixture" || !failed.has(String(item.payload?.competitionId || ""))) continue;
      records.set(item.key, { key: item.key, kind: item.kind, readiness: item.readiness, payload: item.payload });
      for (const key of Object.values(item.payload?.teamAnalysisKeys || {})) preservedAnalysisKeys.add(key);
    }
    for (const key of preservedAnalysisKeys) {
      if (records.has(key)) continue;
      const old = oldByKey.get(key);
      if (old?.payload) records.set(key, { key: old.key, kind: old.kind, readiness: old.readiness, payload: old.payload });
    }

    return { generatedAt: input.generatedAt || now(), sourceWatermark: input.sourceWatermark || null,
      scopeComplete: true, expectedCompetitionIds: expected,
      loadedCompetitionIds: expected, records: [...records.values()], quarantined, minimumHistory: core.MIN_HISTORY,
      outcomes, preservedCompetitions: [...failed] };
  }

  async function publish(input) {
    const batch = await prepareByCompetition(input);
    const result = await core.publishDataCenter(storageAdapter, batch);
    return { ...result, outcomes: batch.outcomes, preservedCompetitions: batch.preservedCompetitions };
  }

  async function prepareFromD1Upcoming() {
    const generatedAt = now();
    const sourceRows = await Promise.all([
      row(`SELECT MAX(updated_at) AS updated_at FROM matches
        WHERE (status IN ('NS','TBD','SCHEDULED') AND datetime(kickoff)>=datetime(?) AND datetime(kickoff)<=datetime(?,'+30 days'))
           OR (status IN ('FT','AET','PEN','FINISHED','COMPLETED') AND datetime(kickoff)>=datetime(?,'-365 days'))`, generatedAt, generatedAt, generatedAt),
      row("SELECT MAX(updated_at) AS updated_at FROM mam_team_identities"),
      row("SELECT MAX(verified_at) AS updated_at FROM mam_team_names WHERE verified=1"),
      row("SELECT MAX(verified_at) AS updated_at FROM mam_team_provider_ids WHERE verified=1")
    ]);
    const sourceWatermark = sourceRows.map(item => item?.updated_at || "").join("|");
    const activeManifest = await row(`SELECT g.manifest_json FROM mam_b_active_generation a
      JOIN mam_b_generations g ON g.generation_id=a.generation_id WHERE a.singleton=1`);
    if (safeJson(activeManifest?.manifest_json)?.sourceWatermark === sourceWatermark) {
      return { noOp: true, reason: "source_watermark_unchanged", fixtureCount: 0, sourceWatermark };
    }
    const upcoming = await rows(`SELECT source, fixture_id, league_id, country, kickoff, status,
        home_team_id, home_team, away_team_id, away_team, raw_json
      FROM matches WHERE status IN ('NS','TBD','SCHEDULED')
        AND datetime(kickoff)>=datetime(?) AND datetime(kickoff)<=datetime(?,'+30 days')
      ORDER BY datetime(kickoff) LIMIT 1500`, generatedAt, generatedAt);
    const fixtures = upcoming.map(item => {
      const raw = safeJson(item.raw_json) || {};
      const home = raw.teams?.home || raw.home || {};
      const away = raw.teams?.away || raw.away || {};
      const countryCode = /^[A-Za-z]{2}$/.test(String(item.country || "")) ? String(item.country).toUpperCase() : "";
      return { provider: String(item.source), providerFixtureId: String(item.fixture_id),
        competitionId: String(item.league_id), kickoff: item.kickoff, status: "scheduled",
        home: { provider: String(item.source), providerTeamId: item.home_team_id ?? home.id ?? null,
          name: item.home_team || home.name || "", countryCode },
        away: { provider: String(item.source), providerTeamId: item.away_team_id ?? away.id ?? null,
          name: item.away_team || away.name || "", countryCode } };
    }).filter(item => item.provider && item.providerFixtureId && item.competitionId && item.kickoff);
    const competitions = [...new Set(fixtures.map(item => item.competitionId))].sort();
    if (!competitions.length) return { noOp: true, reason: "no_upcoming_A_snapshot", fixtureCount: 0 };
    return publish({ generatedAt, sourceWatermark, scopeComplete: true, expectedCompetitionIds: competitions,
      loadedCompetitionIds: competitions, fixtures });
  }

  async function readFixture(key) {
    const active = await row("SELECT generation_id FROM mam_b_active_generation WHERE singleton=1");
    if (!active) return null;
    const base = await row(`SELECT p.payload_json FROM mam_b_generation_items i
      JOIN mam_b_payloads p ON p.payload_hash=i.payload_hash WHERE i.generation_id=? AND i.item_key=? AND i.item_kind='fixture'`,
      active.generation_id, `fixture:${key}`);
    if (!base) return null;
    const live = await row("SELECT * FROM mam_b_live_overlay WHERE fixture_key=?", key);
    return { base: safeJson(base.payload_json), live };
  }

  async function readFixtureBundle(key) {
    const active = await row("SELECT generation_id FROM mam_b_active_generation WHERE singleton=1");
    if (!active) return null;
    const base = await row(`SELECT p.payload_json FROM mam_b_generation_items i
      JOIN mam_b_payloads p ON p.payload_hash=i.payload_hash WHERE i.generation_id=? AND i.item_key=? AND i.item_kind='fixture'`,
      active.generation_id, `fixture:${key}`);
    if (!base) return null;
    const fixture = safeJson(base.payload_json);
    const analyses = {};
    for (const side of ["home", "away"]) {
      const analysisKey = fixture?.teamAnalysisKeys?.[side];
      if (!analysisKey) return null;
      const item = await row(`SELECT p.payload_json FROM mam_b_generation_items i
        JOIN mam_b_payloads p ON p.payload_hash=i.payload_hash WHERE i.generation_id=? AND i.item_key=? AND i.item_kind='team_analysis'`,
        active.generation_id, analysisKey);
      if (!item) return null;
      analyses[side] = { key: analysisKey, payload: safeJson(item.payload_json) };
    }
    return { fixture, analyses };
  }

  async function readFixtureOrFallback(key, fallback) {
    try {
      const found = await readFixture(key);
      if (found?.base?.readiness === "analysis_ready" || found?.base) return { source: "B", value: found };
    } catch (_) { /* B is an optimization; preserve the legacy path. */ }
    return { source: "legacy", value: await fallback(key) };
  }

  return { prepareByCompetition, prepareFromD1Upcoming, publish, readFixture, readFixtureBundle, readFixtureOrFallback,
    applyLiveUpdate: update => core.applyLiveUpdate(storageAdapter, update), storageAdapter };
}

module.exports = { DAILY_B_CRON_UTC, createWorkerBLayer };
