(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.MAMTeamIdentity = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  const groupIndexes = new WeakMap();
  const normalizeTeamName = value => String(value || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i").replace(/&/g, " and ")
    .replace(/[^a-z0-9]/g, "");
  const normalizeToken = value => String(value || "").trim().toLowerCase();
  const isVerified = value => value === true || value === 1;

  function getGroupIndex(groups) {
    if (!Array.isArray(groups)) return new Map();
    let index = groupIndexes.get(groups);
    if (index) return index;
    index = new Map();
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      for (const name of Array.isArray(groups[groupIndex]) ? groups[groupIndex] : []) {
        const key = normalizeTeamName(name);
        if (!key) continue;
        let memberships = index.get(key);
        if (!memberships) index.set(key, memberships = new Set());
        memberships.add(groupIndex);
      }
    }
    groupIndexes.set(groups, index);
    return index;
  }

  function matchesExplicitAliases(left, right, groups = [], additionalPairs = []) {
    const a = normalizeTeamName(left), b = normalizeTeamName(right);
    if (!a || !b) return false;
    if (a === b) return true;
    for (const pair of Array.isArray(additionalPairs) ? additionalPairs : []) {
      if (Array.isArray(pair) && pair.length >= 2) {
        const first = normalizeTeamName(pair[0]), second = normalizeTeamName(pair[1]);
        if ((a === first && b === second) || (a === second && b === first)) return true;
      }
    }
    const index = getGroupIndex(groups), aGroups = index.get(a), bGroups = index.get(b);
    return !!aGroups && !!bGroups && [...aGroups].some(groupId => bGroups.has(groupId));
  }

  function canonicalHistoryKey(value, groups, keyOf, additionalPairs = []) {
    const makeKey = typeof keyOf === "function" ? keyOf : normalizeTeamName;
    const base = makeKey(value);
    if (!base) return "";
    for (const group of Array.isArray(groups) ? groups : []) {
      if (group.some(name => matchesExplicitAliases(name, value, groups, additionalPairs))) return makeKey(group[0]);
    }
    for (const pair of Array.isArray(additionalPairs) ? additionalPairs : []) {
      if (Array.isArray(pair) && pair.length >= 2 && matchesExplicitAliases(value, pair[0], [], additionalPairs)) return makeKey(pair[0]);
    }
    return base;
  }

  function historySearchNames(teamName, acceptedNames, groups = [], additionalPairs = []) {
    const names = new Set([String(teamName || "").trim(), ...Array.from(acceptedNames || [])].filter(Boolean));
    for (const group of Array.isArray(groups) ? groups : []) {
      if (group.some(name => matchesExplicitAliases(name, teamName, groups, additionalPairs))) {
        for (const name of group) names.add(name);
      }
    }
    for (const pair of Array.isArray(additionalPairs) ? additionalPairs : []) {
      if (Array.isArray(pair) && pair.length >= 2 && matchesExplicitAliases(teamName, pair[0], [], additionalPairs)) {
        names.add(pair[0]);
        names.add(pair[1]);
      }
    }
    return [...names];
  }

  function isValidAt(row, eventDate) {
    if (!eventDate) return true;
    const point = Date.parse(eventDate);
    if (!Number.isFinite(point)) return false;
    if (row.validFrom) {
      const start = Date.parse(row.validFrom);
      if (!Number.isFinite(start) || point < start) return false;
    }
    if (row.validTo) {
      const end = Date.parse(row.validTo);
      if (!Number.isFinite(end) || point >= end) return false;
    }
    return true;
  }

  function compatibleContext(candidate, record) {
    for (const key of ["countryCode", "competitionId", "leagueId"]) {
      const expected = normalizeToken(candidate?.[key]);
      const actual = normalizeToken(record?.[key]);
      if (expected && actual && expected !== actual) return false;
    }
    return true;
  }

  function resolveIdentity(candidate, identities = [], reviewCandidates = []) {
    const input = candidate || {};
    const provider = normalizeToken(input.provider);
    const providerTeamId = String(input.providerTeamId ?? "").trim();
    const eventDate = input.eventDate || "";

    if (provider && providerTeamId) {
      const providerMatches = [];
      for (const identity of Array.isArray(identities) ? identities : []) {
        for (const link of Array.isArray(identity.providerIds) ? identity.providerIds : []) {
          if (normalizeToken(link.provider) !== provider || String(link.providerTeamId ?? "").trim() !== providerTeamId ||
              !isVerified(link.verified) || !isValidAt(link, eventDate) || !compatibleContext(input, { ...identity, ...link })) continue;
          providerMatches.push(identity.teamId);
        }
      }
      const ids = [...new Set(providerMatches.filter(Boolean))];
      if (ids.length === 1) return { status: "matched", teamId: ids[0], method: "verified_provider_id" };
      if (ids.length > 1) return { status: "ambiguous", teamId: null, reason: "provider_id_conflict", candidateTeamIds: ids };
    }

    const normalized = normalizeTeamName(input.name);
    const nameMatches = [];
    if (normalized) {
      for (const identity of Array.isArray(identities) ? identities : []) {
        for (const name of Array.isArray(identity.names) ? identity.names : []) {
          const savedName = normalizeTeamName(name.normalizedName || name.displayName || name.name);
          if (savedName !== normalized || !isVerified(name.verified) || !isValidAt(name, eventDate) ||
              !compatibleContext(input, { ...identity, ...name })) continue;
          nameMatches.push(identity.teamId);
        }
      }
    }
    const nameIds = [...new Set(nameMatches.filter(Boolean))];
    const pending = (Array.isArray(reviewCandidates) ? reviewCandidates : []).filter(item =>
      normalizeTeamName(item.rawName || item.displayName || item.name) === normalized &&
      normalizeToken(item.status || "pending") === "pending" && compatibleContext(input, item));
    const pendingIds = [...new Set(pending.map(item => item.suggestedTeamId).filter(Boolean))];

    if (nameIds.length > 1) return { status: "ambiguous", teamId: null, reason: "name_maps_to_multiple_teams", candidateTeamIds: nameIds };
    if (nameIds.length === 1) {
      if (pending.length && pendingIds.some(id => id !== nameIds[0])) {
        return { status: "ambiguous", teamId: null, reason: "verified_name_conflicts_with_pending_candidate", candidateTeamIds: [...new Set([...nameIds, ...pendingIds])] };
      }
      return { status: "matched", teamId: nameIds[0], method: "verified_name" };
    }
    if (pending.length) return { status: "needs_review", teamId: null, reason: "unapproved_name_candidate" };
    return { status: "unresolved", teamId: null, reason: "no_verified_identity" };
  }

  function applyVerifiedRename(identity, change) {
    const team = identity || {}, update = change || {};
    const newName = String(update.newName || "").trim();
    const effectiveAt = String(update.effectiveAt || "");
    if (!team.teamId || !newName || !Number.isFinite(Date.parse(effectiveAt)) || !update.approvedBy || !update.source) {
      throw new TypeError("A team ID, valid new name, effective date, approval, and source are required.");
    }
    const names = Array.isArray(team.names) ? team.names.map(name => ({ ...name })) : [];
    const current = names.filter(name => name.nameType === "current" && isVerified(name.verified) && !name.validTo);
    if (current.length !== 1) throw new Error("Rename requires exactly one verified current team name.");
    if (normalizeTeamName(current[0].displayName || current[0].name) === normalizeTeamName(newName)) return { ...team, names };

    const oldCurrent = current[0];
    oldCurrent.nameType = "former";
    oldCurrent.validTo = effectiveAt;
    oldCurrent.changeSource = update.source;
    oldCurrent.changeApprovedBy = update.approvedBy;
    names.push({
      nameId: `${team.teamId}:current:${effectiveAt}:${normalizeTeamName(newName)}`,
      displayName: newName,
      nameType: "current",
      verified: true,
      validFrom: effectiveAt,
      validTo: null,
      source: update.source,
      approvedBy: update.approvedBy
    });
    return { ...team, names };
  }

  return Object.freeze({
    normalizeTeamName,
    matchesExplicitAliases,
    canonicalHistoryKey,
    historySearchNames,
    resolveIdentity,
    applyVerifiedRename
  });
});
