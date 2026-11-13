const ALLOWED_ORIGIN = "https://mahmetisildak34.github.io";
const API_BASE = "https://v3.football.api-sports.io";
const FOOTBALLDATA_BASE = "https://api.football-data.org/v4";
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const CACHE_SECONDS = 43200;
const STANDINGS_CACHE_SECONDS = 300;

async function verifySessionToken(token, secret) {
  if (!token || !secret) return false;
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
  );
  let sig;
  try {
    sig = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const data = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (!data.exp || data.exp < Date.now() || data.v !== 1) return false;
  } catch (_) { return false; }
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(payload));
}

async function createSessionToken(secret) {
  const payload = btoa(JSON.stringify({ v: 1, exp: Date.now() + 90 * 24 * 60 * 60 * 1000 }))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return payload + "." + signature;
}


function normalizeTeamName(value) {
  return String(value || "").normalize("NFD").toLowerCase()
    .replace(/[\u0300-\u036f]/g, "").replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

async function saveDailyArchive(env, scheduledTime) {
  if (!env.MAM_KV) throw new Error("MAM_KV KV binding is missing");
  const date = new Date(scheduledTime || Date.now());
  date.setUTCDate(date.getUTCDate() - 1);
  const day = date.toISOString().slice(0, 10);
  let fixtures = [];
  let primaryError = "";
  const loadFootballDataFallback = async () => {
    if (!env.FOOTBALLDATA_API_KEY) {
      throw new Error("FOOTBALLDATA_API_KEY secret is missing");
    }
    const fallback = await fetch(FOOTBALLDATA_BASE + "/matches?dateFrom=" + day + "&dateTo=" + day, {
      headers: { "X-Auth-Token": env.FOOTBALLDATA_API_KEY }
    });
    if (!fallback.ok) throw new Error("Football-data.org HTTP " + fallback.status);
    const data = await fallback.json();
    return (data.matches || []).map(match => ({
      fixture: { id: match.id, date: match.utcDate, status: { short: ["FINISHED","AWARDED"].includes(match.status) ? "FT" : match.status } },
      league: { id: match.competition?.id, name: match.competition?.name, country: match.area?.name },
      teams: {
        home: { id: match.homeTeam?.id, name: match.homeTeam?.name },
        away: { id: match.awayTeam?.id, name: match.awayTeam?.name }
      },
      goals: { home: match.score?.fullTime?.home, away: match.score?.fullTime?.away },
      score: null,
      statistics: null
    }));
  };
  try {
    if (!env.API_FOOTBALL_KEY) throw new Error("API_FOOTBALL_KEY secret is missing; trying fallback provider");
    const upstream = await fetch(API_BASE + "/fixtures?date=" + day, {
      headers: { "x-apisports-key": env.API_FOOTBALL_KEY }
    });
    if (!upstream.ok) throw new Error("HTTP " + upstream.status);
    const payload = await upstream.json();
    if (payload.errors && Object.keys(payload.errors).length) {
      throw new Error(JSON.stringify(payload.errors));
    }
    fixtures = Array.isArray(payload.response) ? payload.response : [];
  } catch (error) {
    primaryError = String(error && error.message ? error.message : error);
  }

  // Always try the secondary provider when configured. Merge by match identity
  // later so it fills gaps even when the primary provider returned some matches.
  if (env.FOOTBALLDATA_API_KEY) {
    try {
      const fallbackFixtures = await loadFootballDataFallback();
      if (fallbackFixtures.length) fixtures = [...fixtures, ...fallbackFixtures];
    } catch (fallbackError) {
      if (!fixtures.length) {
        throw new Error("API-Football failed (" + (primaryError || "no completed fixtures") + "); fallback failed (" + String(fallbackError?.message || fallbackError) + ")");
      }
    }
  } else if (!fixtures.length) {
    throw new Error("No usable provider: " + (primaryError || "API-Football returned no fixtures") + "; FOOTBALLDATA_API_KEY secret is missing");
  }
  const grouped = new Map();
  for (const item of fixtures) {
    const status = String(item.fixture?.status?.short || "");
    if (!["FT", "AET", "PEN"].includes(status)) continue;
    if (item.goals?.home == null || item.goals?.away == null) continue;
    const match = {
      fixture: { id: item.fixture?.id, date: item.fixture?.date, status: { short: status } },
      league: { id: item.league?.id, name: item.league?.name, country: item.league?.country },
      teams: {
        home: { id: item.teams?.home?.id, name: item.teams?.home?.name },
        away: { id: item.teams?.away?.id, name: item.teams?.away?.name }
      },
      goals: { home: item.goals.home, away: item.goals.away },
      score: item.score || null,
      statistics: null
    };
    for (const teamName of [match.teams.home.name, match.teams.away.name]) {
      const key = normalizeTeamName(teamName);
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(match);
    }
  }
  let savedTeams = 0;
  for (const [teamKey, matches] of grouped) {
    const storageKey = "history:" + teamKey;
    let previous = [];
    try {
      previous = await env.MAM_KV.get(storageKey, "json") || [];
    } catch (_) {}
    const combined = new Map();
    for (const match of [...previous, ...matches]) {
      const id = [String(match.fixture?.date || "").slice(0, 10), match.teams?.home?.name, match.teams?.away?.name].join("|");
      combined.set(id, match);
    }
    const history = [...combined.values()]
      .sort((a, b) => new Date(b.fixture.date) - new Date(a.fixture.date))
      .slice(0, 30);
    await env.MAM_KV.put(storageKey, JSON.stringify(history), { expirationTtl: 400 * 24 * 60 * 60 });
    savedTeams++;
  }
  const completedFixtures = fixtures.filter(x => ["FT","AET","PEN"].includes(String(x.fixture?.status?.short||"")) && x.goals?.home != null && x.goals?.away != null).length;
  await env.MAM_KV.put("archive:last-run", JSON.stringify({
    date: day, completedFixtures, teamsUpdated: savedTeams, updatedAt: new Date().toISOString(),
    providers: [env.API_FOOTBALL_KEY ? "API-Football" : null, env.FOOTBALLDATA_API_KEY ? "Football-data.org" : null].filter(Boolean)
  }), { expirationTtl: 400 * 24 * 60 * 60 });
  await env.MAM_KV.delete("archive:last-error");
  return { date: day, teamsUpdated: savedTeams, fixturesReceived: fixtures.length, completedFixtures };
}

export default {
  // KV ücretsiz yazma kotası koruması: günlük otomatik arşiv yazımı duraklatıldı.
  async scheduled() {
    return;
  },
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };

    if (origin && origin !== ALLOWED_ORIGIN) {
      return new Response("Origin not allowed", { status: 403 });
    }


    const headers = { ...cors, "Content-Type": "application/json; charset=utf-8" };
    const url = new URL(request.url);
    if (url.pathname === "/auth/login" && request.method === "POST") {
      if (!env.SITE_PASSWORD || !env.SESSION_SECRET) {
        return new Response(JSON.stringify({ error: "Authentication secrets are not configured" }), { status: 503, headers });
      }
      let body = {};
      try { body = await request.json(); } catch (_) {}
      if (typeof body.password !== "string" || body.password !== env.SITE_PASSWORD) {
        return new Response(JSON.stringify({ error: "Wrong password" }), { status: 401, headers });
      }
      const token = await createSessionToken(env.SESSION_SECRET);
      return new Response(JSON.stringify({ token, expiresIn: 90 * 24 * 60 * 60 }), { status: 200, headers });
    }
    if (url.pathname === "/auth/check" && request.method === "GET") {
      const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
      const ok = await verifySessionToken(token, env.SESSION_SECRET);
      return new Response(JSON.stringify({ ok }), { status: ok ? 200 : 401, headers });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }

    try {
      const url = new URL(request.url);

      if (!url.pathname.startsWith("/api/")) {
        return new Response("Invalid API path", {
          status: 400,
          headers: cors
        });
      }

      const path = url.pathname.replace(/^\/api\//, "");

      const isESPN = path.startsWith("espn/");
      const validESPNPath = /^espn\/[a-zA-Z0-9._-]+\/(?:scoreboard|summary|standings|teams|teams\/[0-9]+\/schedule)$/.test(path) && ( !path.endsWith("/summary") || /^\d+$/.test(url.searchParams.get("event") || "") );
      const validStandardPath = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path);

      if (!(isESPN ? validESPNPath : validStandardPath)) {
        return new Response("Invalid API path", {
          status: 400,
          headers: cors
        });
      }

      const sessionToken = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") || "";
      if (!(await verifySessionToken(sessionToken, env.SESSION_SECRET))) {
        return new Response(JSON.stringify({ error: "Authentication required" }), {
          status: 401, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" }
        });
      }

      if (path === "archive/status") {
        if (!env.MAM_KV) {
          return new Response(JSON.stringify({ error: "MAM_KV KV binding is missing" }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const [lastRun, lastError, teamKeys] = await Promise.all([
          env.MAM_KV.get("archive:last-run", "json"),
          env.MAM_KV.get("archive:last-error", "json"),
          env.MAM_KV.list({ prefix: "history:", limit: 1000 })
        ]);
        let archivedMatchesTotal = 0;
        let teamsWithMatches = 0;
        let emptyTeamKeys = 0;
        for (const item of teamKeys.keys) {
          const rows = await env.MAM_KV.get(item.name, "json") || [];
          const count = Array.isArray(rows) ? rows.length : 0;
          archivedMatchesTotal += count;
          if (count > 0) teamsWithMatches++;
          else emptyTeamKeys++;
        }
        return new Response(JSON.stringify({
          ok: Boolean(lastRun) && !lastError,
          lastRun: lastRun || null,
          lastError: lastError || null,
          archivedTeamsListed: teamKeys.keys.length,
          teamsWithMatches,
          emptyTeamKeys,
          archivedMatchesTotal,
          moreTeams: Boolean(teamKeys.list_complete === false)
        }), {
          status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" }
        });
      }

      if (path === "archive/backfill-all" || path === "archive/espn-backfill") {
        return new Response(JSON.stringify({
          error: "KV archive writes are paused to protect the free-tier daily write quota. Read-only archive access remains available."
        }), { status: 410, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
      }

      if (path === "archive/team") {
        if (!env.MAM_KV) {
          return new Response(JSON.stringify({ error: "MAM_KV KV binding is missing" }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const teamName = url.searchParams.get("name") || "";
        const key = normalizeTeamName(teamName);
        if (!key) {
          return new Response(JSON.stringify({ error: "A team name is required" }), {
            status: 400, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const matches = await env.MAM_KV.get("history:" + key, "json") || [];
        return new Response(JSON.stringify({ response: matches, source: "Cloudflare daily archive" }), {
          status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" }
        });
      }

      const isFootballData = path.startsWith("football-data/");
      const apiPath = isESPN
        ? path.slice("espn/".length)
        : isFootballData
          ? path.slice("football-data/".length)
          : path;

      const apiKey = isESPN
        ? null
        : isFootballData
          ? env.FOOTBALLDATA_API_KEY
          : env.API_FOOTBALL_KEY;

      if (!isESPN && !apiKey) {
        return new Response(JSON.stringify({
          error: isFootballData
            ? "FOOTBALLDATA_API_KEY secret is missing"
            : "API_FOOTBALL_KEY secret is missing"
        }), {
          status: 500,
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }

      const isESPNStandings = isESPN && apiPath.endsWith("/standings");
      const base = isESPNStandings ? "https://site.api.espn.com/apis/v2/sports/soccer" : isESPN ? ESPN_BASE : isFootballData ? FOOTBALLDATA_BASE : API_BASE;
      const targetUrl = base + "/" + apiPath + url.search;
      const isStandings = /(^|\/)standings$/.test(apiPath);
      const isLive = url.searchParams.get("live") === "all";
      const isLiveStats = apiPath === "fixtures/statistics" || (isESPN && apiPath === "summary");
      const isLineupData = apiPath === "fixtures/lineups" || apiPath === "fixtures/players";
      const cacheUrl = new URL(url.toString());
      // Yeni anahtar, önceki 12 saatlik puan tablosu kayıtlarını devre dışı bırakır.
      if (isStandings) cacheUrl.searchParams.set("__mam_cache", "standings-v2");
      if (isLive) cacheUrl.searchParams.set("__mam_cache", "live-v1");
      if (isLiveStats) cacheUrl.searchParams.set("__mam_cache", "live-stats-v1");
      if (isLineupData) cacheUrl.searchParams.set("__mam_cache", "lineups-v1");
      const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });

      let cache = null;

      try {
        cache = caches.default;
        const cached = await cache.match(cacheKey);

        if (cached) {
          const headers = new Headers(cached.headers);
          Object.entries(cors).forEach(([key, value]) => {
            headers.set(key, value);
          });

          return new Response(cached.body, {
            status: cached.status,
            statusText: cached.statusText,
            headers
          });
        }
      } catch (cacheError) {
        cache = null;
      }

      const upstreamHeaders = isESPN
        ? { "Accept": "application/json" }
        : isFootballData
          ? { "X-Auth-Token": apiKey }
          : { "x-apisports-key": apiKey };

      const upstream = await fetch(targetUrl, {
        method: "GET",
        headers: upstreamHeaders
      });

      const responseHeaders = new Headers(cors);
      responseHeaders.set(
        "Content-Type",
        upstream.headers.get("Content-Type") || "application/json; charset=utf-8"
      );

      const response = new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders
      });

      if (upstream.ok && cache && !isLive) {
        const cacheHeaders = new Headers(response.headers);
        const responseCacheSeconds = isLineupData ? 300 : isESPN && apiPath === "summary" ? 300 : isLiveStats ? 60 : isESPN ? 900 : isStandings ? STANDINGS_CACHE_SECONDS : CACHE_SECONDS;
        cacheHeaders.set("Cache-Control", "public, max-age=" + responseCacheSeconds);

        const cacheCopy = new Response(response.clone().body, {
          status: response.status,
          statusText: response.statusText,
          headers: cacheHeaders
        });

        try {
          await cache.put(cacheKey, cacheCopy);
        } catch (cacheError) {
          // Cache failure must not block the API response.
        }
      }

      return response;
    } catch (error) {
      return new Response(JSON.stringify({
        error: "Worker request failed",
        detail: String(error && error.message ? error.message : error)
      }), {
        status: 502,
        headers: { ...cors, "Content-Type": "application/json" }
      });
    }
  }
};
