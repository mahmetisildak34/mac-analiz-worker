"use strict";

// B data-center adapter. The Worker must fail closed until both release gates are
// explicitly enabled and the separately approved additive D1 migrations exist.
const DAILY_B_CRON_UTC = "1 21 * * *";
const B_RELEASE_GATE_ENV = "MAM_DATA_CENTER_B_RELEASE_GATE";
const B_RUNTIME_SWITCH_KEY = "mam:feature:data-center-b";
const FINAL_STATUSES = new Set(["FT", "AET", "PEN", "COMPLETED", "FINISHED", "FULL TIME"]);
const safeJson = value => { try { return value ? JSON.parse(value) : null; } catch (_) { return null; } };
const hasScore = value => Number.isInteger(value) && value >= 0;

async function isDataCenterEnabled(env) {
  if (env?.[B_RELEASE_GATE_ENV] !== "true" || typeof env?.MAM_KV?.get !== "function") return false;
  try {
    return await env.MAM_KV.get(B_RUNTIME_SWITCH_KEY) === "on";
  } catch (_) {
    return false;
  }
}

function createWorkerBLayer({ DB, core, identityApi, now = () => new Date().toISOString() }) {
  if (!DB || !core || typeof core.prepareDataCenter !== "function" ||
      typeof core.publishDataCenter !== "function" || typeof identityApi?.resolveIdentity !== "function") {
    throw new TypeError("D1, the B core, and the team identity resolver are required.");
  }
  let expectedActiveId = null;
  let d1Metrics = { statementCount: 0, rowsRead: 0, rowsWritten: 0, durationMs: 0 };

  function resetD1Metrics() {
    d1Metrics = { statementCount: 0, rowsRead: 0, rowsWritten: 0, durationMs: 0 };
  }
  function recordD1Meta(meta) {
    if (!meta) return;
    d1Metrics.statementCount++;
    d1Metrics.rowsRead += Number(meta.rows_read) || 0;
    d1Metrics.rowsWritten += Number(meta.rows_written) || 0;
    d1Metrics.durationMs += Number(meta.duration ?? meta.timings?.sql_duration_ms) || 0;
  }
  function d1MetricsSnapshot() { return { ...d1Metrics }; }

  async function rows(sql, ...values) {
    let statement = DB.prepare(sql);
    if (values.length) statement = statement.bind(...values);
    const result = await statement.all();
    recordD1Meta(result?.meta);
    return Array.isArray(result?.results) ? result.results : [];
  }
  async function row(sql, ...values) {
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

  // The statistics table is an optional additive migration. Read it only when
  // it exists so the adapter keeps working on a target that has 0001-0004.
  let verifiedStatisticsTable = null;
  let verifiedHalftimeTable = null;
  async function hasVerifiedStatisticsTable() {
    if (verifiedStatisticsTable === null) {
      verifiedStatisticsTable = !!(await row("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='mam_verified_history_statistics'"));
    }
    return verifiedStatisticsTable;
  }

  // Verified halftime scores arrived with migration 0006. Older databases (and
  // the current production D1 until that migration is approved there) do not
  // have the table, so the read degrades to archive raw scores instead.
  async function hasVerifiedHalftimeTable() {
    if (verifiedHalftimeTable === null) {
      verifiedHalftimeTable = !!(await row("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='mam_verified_history_halftime'"));
    }
    return verifiedHalftimeTable;
  }

  // Query legacy history only with two persisted, approved side-to-team links.
  // Separately verified provider history is read from its own additive table;
  // it must agree with the stored canonical team/opponent side assignment.
  // There is intentionally no league filter: a canonical team can use verified
  // history from any competition. Team/date indexes bound the per-team reads.
  async function loadHistoryForTeam(teamId, before) {
    // Correlated scalar subquery instead of a join: the statistics table is
    // read only for rows that already matched a verified history row of the
    // selected team, so no extra bindings shift the history parameters.
    const statisticsSelect = (await hasVerifiedStatisticsTable()) ? `,
             (SELECT json_group_array(json_object('name', metric, 'value', value, 'unit', unit,
                       'provider', provider, 'verified', json('true')))
              FROM mam_verified_history_statistics s
              WHERE s.provider=history.source AND s.provider_fixture_id=history.fixture_id
                AND s.team_id=history.verified_team_id) AS verified_statistics_json` : `,
             NULL AS verified_statistics_json`;
    const verifiedHalfColumns = (await hasVerifiedHalftimeTable()) ? `,
             (SELECT h.halftime_home FROM mam_verified_history_halftime h
              WHERE h.provider=v.provider AND h.provider_fixture_id=v.provider_fixture_id
                AND h.team_id=v.team_id) AS halftime_home,
             (SELECT h.halftime_away FROM mam_verified_history_halftime h
              WHERE h.provider=v.provider AND h.provider_fixture_id=v.provider_fixture_id
                AND h.team_id=v.team_id) AS halftime_away` : ", NULL AS halftime_home, NULL AS halftime_away";
    const archiveHalfColumns = "NULL AS halftime_home, NULL AS halftime_away";
    const sql = `
      WITH history AS (
      SELECT DISTINCT m.source, m.fixture_id, m.league_id, m.kickoff, m.status,
             m.home_goals, m.away_goals, m.statistics_json, m.raw_json,
             h.team_id AS canonical_home_team_id, a.team_id AS canonical_away_team_id,
             'matches' AS history_source, NULL AS verified_team_id, NULL AS verified_opponent_team_id,
             NULL AS verification_source, ${archiveHalfColumns}
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
             h.team_id AS canonical_home_team_id, a.team_id AS canonical_away_team_id,
             'matches' AS history_source, NULL AS verified_team_id, NULL AS verified_opponent_team_id,
             NULL AS verification_source, ${archiveHalfColumns}
      FROM mam_team_match_links selected
      JOIN matches m ON m.source=selected.provider AND m.fixture_id=selected.provider_fixture_id
      JOIN mam_team_match_links h ON h.provider=m.source AND h.provider_fixture_id=m.fixture_id AND h.side='home'
      JOIN mam_team_match_links a ON a.provider=m.source AND a.provider_fixture_id=m.fixture_id AND a.side='away'
      WHERE selected.team_id=? AND selected.side='away' AND selected.match_date < substr(?,1,10)
        AND m.kickoff < ? AND upper(m.status) IN ('FT','AET','PEN','COMPLETED','FINISHED','FULL TIME')
        AND m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL
      UNION
      SELECT v.provider, v.provider_fixture_id, v.competition_id, v.kickoff, v.status,
             v.home_score, v.away_score, NULL, NULL, v.home_team_id, v.away_team_id,
             'verified' AS history_source, v.team_id, v.opponent_team_id, v.source${verifiedHalfColumns}
      FROM mam_verified_history_matches v
      WHERE v.team_id=? AND v.kickoff<? AND v.status='completed' AND v.verified=1
        AND v.home_score IS NOT NULL AND v.away_score IS NOT NULL
      )
      SELECT DISTINCT history.source, history.fixture_id, history.league_id, history.kickoff, history.status,
             history.home_goals, history.away_goals, history.statistics_json, history.raw_json,
             history.canonical_home_team_id, history.canonical_away_team_id,
             history.history_source, history.verified_team_id, history.verified_opponent_team_id,
             history.verification_source, history.halftime_home, history.halftime_away${statisticsSelect}
      FROM history
      ORDER BY history.kickoff DESC LIMIT 100`;
    const found = await rows(sql, teamId, before, before, teamId, before, before, teamId, before);
    return found.filter(item => {
      if (!item.source || !item.fixture_id || !item.league_id || !item.kickoff ||
          !item.canonical_home_team_id || !item.canonical_away_team_id ||
          item.canonical_home_team_id === item.canonical_away_team_id ||
          !hasScore(Number(item.home_goals)) || !hasScore(Number(item.away_goals))) return false;
      if (item.history_source !== "verified") return true;
      if (!String(item.verification_source || "").trim()) return false;
      const selectedTeam = String(item.verified_team_id || "");
      const opponentTeam = String(item.verified_opponent_team_id || "");
      const homeTeam = String(item.canonical_home_team_id || "");
      const awayTeam = String(item.canonical_away_team_id || "");
      return selectedTeam === String(teamId) && opponentTeam &&
        ((homeTeam === selectedTeam && awayTeam === opponentTeam) ||
         (awayTeam === selectedTeam && homeTeam === opponentTeam));
    })
      .map(item => {
        const raw = safeJson(item.raw_json);
        const rawHalf = raw?.score?.halftime || raw?.score?.halfTime || raw?.halftime || null;
        // Verified columns win over archive raw scores: they are the separately
        // captured values written with migration 0006.
        const verifiedHalfHome = item.halftime_home === null || item.halftime_home === undefined ? null : Number(item.halftime_home);
        const verifiedHalfAway = item.halftime_away === null || item.halftime_away === undefined ? null : Number(item.halftime_away);
        const halfHome = hasScore(verifiedHalfHome) && hasScore(verifiedHalfAway) ? verifiedHalfHome : (rawHalf?.homeScore ?? rawHalf?.home);
        const halfAway = hasScore(verifiedHalfHome) && hasScore(verifiedHalfAway) ? verifiedHalfAway : (rawHalf?.awayScore ?? rawHalf?.away);
        const fullHome = Number(item.home_goals), fullAway = Number(item.away_goals);
        // A halftime score can never exceed the full-time score of either side.
        const halftime = hasScore(Number(halfHome)) && hasScore(Number(halfAway)) &&
          Number(halfHome) <= fullHome && Number(halfAway) <= fullAway
          ? { homeScore: Number(halfHome), awayScore: Number(halfAway), provider: String(item.source) } : null;
        // Prefer the separately double-captured statistics table; fall back to
        // the legacy archive column only when it stores explicit per-value
        // verification. The core applies its own verified filter too.
        const capturedStats = safeJson(item.verified_statistics_json);
        const legacyStats = safeJson(item.statistics_json);
        const statistics = Array.isArray(capturedStats) && capturedStats.length
          ? capturedStats.filter(value => value?.verified === true)
          : (Array.isArray(legacyStats) ? legacyStats.filter(value => value?.verified === true) : []);
        return { provider: String(item.source), providerFixtureId: String(item.fixture_id),
          kickoff: item.kickoff, competitionId: String(item.league_id),
          homeTeamId: item.canonical_home_team_id, awayTeamId: item.canonical_away_team_id,
          homeScore: Number(item.home_goals), awayScore: Number(item.away_goals),
          status: "completed", verified: true, halftime, statistics,
          verificationSource: item.history_source === "verified" ? String(item.verification_source) : null };
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
    const writeBatch = async statements => {
      if (!statements.length) return;
      const results = await DB.batch(statements);
      if (Array.isArray(results)) for (const result of results) recordD1Meta(result?.meta);
    };
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
      recordD1Meta(result?.meta);
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
    return { ...result, outcomes: batch.outcomes, preservedCompetitions: batch.preservedCompetitions,
      d1Metrics: d1MetricsSnapshot() };
  }

  async function prepareFromD1Upcoming() {
    resetD1Metrics();
    const generatedAt = now();
    const hasFixtureStaging = await row("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='mam_b_fixture_staging'");
    const stagingWatermark = hasFixtureStaging
      ? await row("SELECT MAX(verified_at) AS updated_at FROM mam_b_fixture_staging WHERE verified=1 AND status='scheduled'")
      : null;
    const sourceRows = await Promise.all([
      row(`SELECT MAX(updated_at) AS updated_at FROM matches
        WHERE (status IN ('NS','TBD','SCHEDULED') AND datetime(kickoff)>=datetime(?) AND datetime(kickoff)<=datetime(?,'+30 days'))
           OR (status IN ('FT','AET','PEN','FINISHED','COMPLETED') AND datetime(kickoff)>=datetime(?,'-365 days'))`, generatedAt, generatedAt, generatedAt),
      row("SELECT MAX(updated_at) AS updated_at FROM mam_team_identities"),
      row("SELECT MAX(verified_at) AS updated_at FROM mam_team_names WHERE verified=1"),
      row("SELECT MAX(verified_at) AS updated_at FROM mam_team_provider_ids WHERE verified=1"),
      Promise.resolve(stagingWatermark)
    ]);
    const sourceWatermark = sourceRows.map(item => item?.updated_at || "").join("|");
    const activeManifest = await row(`SELECT g.manifest_json FROM mam_b_active_generation a
      JOIN mam_b_generations g ON g.generation_id=a.generation_id WHERE a.singleton=1`);
    if (safeJson(activeManifest?.manifest_json)?.sourceWatermark === sourceWatermark) {
      return { noOp: true, reason: "source_watermark_unchanged", fixtureCount: 0, sourceWatermark,
        d1Metrics: d1MetricsSnapshot() };
    }
    const upcomingUntil = new Date(Date.parse(generatedAt) + 30 * 24 * 60 * 60 * 1000).toISOString();
    const [upcoming, stagedUpcoming] = await Promise.all([
      rows(`SELECT source, fixture_id, league_id, country, kickoff, status,
          home_team_id, home_team, away_team_id, away_team, raw_json
        FROM matches WHERE status IN ('NS','TBD','SCHEDULED')
          AND datetime(kickoff)>=datetime(?) AND datetime(kickoff)<=datetime(?,'+30 days')
        ORDER BY datetime(kickoff) LIMIT 1500`, generatedAt, generatedAt),
      hasFixtureStaging ? rows(`SELECT provider, provider_fixture_id, competition_id, kickoff, status,
          home_provider_team_id, home_team_name, home_country_code,
          away_provider_team_id, away_team_name, away_country_code
        FROM mam_b_fixture_staging WHERE verified=1 AND status='scheduled' AND kickoff>=? AND kickoff<=?
        ORDER BY kickoff LIMIT 1500`, generatedAt, upcomingUntil) : Promise.resolve([])
    ]);
    const archiveFixtures = upcoming.map(item => {
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
    const stagedFixtures = stagedUpcoming.map(item => ({
      provider: String(item.provider), providerFixtureId: String(item.provider_fixture_id),
      competitionId: String(item.competition_id), kickoff: item.kickoff, status: "scheduled",
      home: { provider: String(item.provider), providerTeamId: String(item.home_provider_team_id),
        name: String(item.home_team_name), countryCode: String(item.home_country_code || "") },
      away: { provider: String(item.provider), providerTeamId: String(item.away_provider_team_id),
        name: String(item.away_team_name), countryCode: String(item.away_country_code || "") }
    })).filter(item => item.provider && item.providerFixtureId && item.competitionId && item.kickoff);
    const fixturesByKey = new Map();
    const keyOf = fixture => `${fixture.provider.toLowerCase()}:${fixture.providerFixtureId}`;
    for (const fixture of archiveFixtures) fixturesByKey.set(keyOf(fixture), fixture);
    for (const fixture of stagedFixtures) if (!fixturesByKey.has(keyOf(fixture))) fixturesByKey.set(keyOf(fixture), fixture);
    const fixtures = [...fixturesByKey.values()];
    const competitions = [...new Set(fixtures.map(item => item.competitionId))].sort();
    if (!competitions.length) return { noOp: true, reason: "no_upcoming_A_snapshot", fixtureCount: 0, sourceWatermark,
      d1Metrics: d1MetricsSnapshot(), archiveFixtureCount: 0, stagedFixtureCount: 0 };
    return { ...await publish({ generatedAt, sourceWatermark, scopeComplete: true, expectedCompetitionIds: competitions,
      loadedCompetitionIds: competitions, fixtures }), archiveFixtureCount: archiveFixtures.length,
      stagedFixtureCount: stagedFixtures.length };
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

module.exports = { DAILY_B_CRON_UTC, B_RELEASE_GATE_ENV, B_RUNTIME_SWITCH_KEY, isDataCenterEnabled, createWorkerBLayer };
