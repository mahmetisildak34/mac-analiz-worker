const ALLOWED_ORIGIN = "https://mahmetisildak34.github.io";
const API_BASE = "https://v3.football.api-sports.io";
const FOOTBALLDATA_BASE = "https://api.football-data.org/v4";
const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const CACHE_SECONDS = 43200;
const STANDINGS_CACHE_SECONDS = 300;

function normalizeTeamName(value) {
  return String(value || "").normalize("NFD").toLowerCase()
    .replace(/[\\u0300-\\u036f]/g, "").replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

async function saveDailyArchive(env, scheduledTime) {
  if (!env.MAM_KV) throw new Error("MAM_KV KV binding is missing");
  if (!env.API_FOOTBALL_KEY) throw new Error("API_FOOTBALL_KEY secret is missing");
  const date = new Date(scheduledTime || Date.now());
  date.setUTCDate(date.getUTCDate() - 1);
  const day = date.toISOString().slice(0, 10);
  const upstream = await fetch(API_BASE + "/fixtures?date=" + day, {
    headers: { "x-apisports-key": env.API_FOOTBALL_KEY }
  });
  if (!upstream.ok) throw new Error("API-Football archive request failed: HTTP " + upstream.status);
  const payload = await upstream.json();
  if (payload.errors && Object.keys(payload.errors).length) {
    throw new Error("API-Football archive error: " + JSON.stringify(payload.errors));
  }
  const fixtures = Array.isArray(payload.response) ? payload.response : [];
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
  await env.MAM_KV.put("archive:last-run", JSON.stringify({
    date: day, completedFixtures: fixtures.filter(x => ["FT","AET","PEN"].includes(String(x.fixture?.status?.short||""))).length,
    teamsUpdated: savedTeams, updatedAt: new Date().toISOString()
  }), { expirationTtl: 400 * 24 * 60 * 60 });
  return { date: day, teamsUpdated: savedTeams, fixturesReceived: fixtures.length };
}

export default {
  async scheduled(controller, env, ctx) {
    await saveDailyArchive(env, controller?.scheduledTime || Date.now());
  },
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };

    if (origin && origin !== ALLOWED_ORIGIN) {
      return new Response("Origin not allowed", { status: 403 });
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
      const validESPNPath = /^espn\/[a-zA-Z0-9._-]+\/(?:scoreboard|teams|teams\/[0-9]+\/schedule)$/.test(path);
      const validStandardPath = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path);

      if (!(isESPN ? validESPNPath : validStandardPath)) {
        return new Response("Invalid API path", {
          status: 400,
          headers: cors
        });
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

      const base = isESPN ? ESPN_BASE : isFootballData ? FOOTBALLDATA_BASE : API_BASE;
      const targetUrl = base + "/" + apiPath + url.search;
      const isStandings = /(^|\/)standings$/.test(apiPath);
      const isLive = url.searchParams.get("live") === "all";
      const cacheUrl = new URL(url.toString());
      // Yeni anahtar, önceki 12 saatlik puan tablosu kayıtlarını devre dışı bırakır.
      if (isStandings) cacheUrl.searchParams.set("__mam_cache", "standings-v2");
      if (isLive) cacheUrl.searchParams.set("__mam_cache", "live-v1");
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
        cacheHeaders.set("Cache-Control", "public, max-age=" + (isESPN ? 900 : isStandings ? STANDINGS_CACHE_SECONDS : CACHE_SECONDS));

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
