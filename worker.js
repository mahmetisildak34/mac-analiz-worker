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

// KV archive writes are intentionally disabled on the free tier.
// Historical matches are served read-only from existing KV data and the app's CSV/ESPN fallbacks.

export default {
  // Daily TFF fixture sync: one KV write per run, keeping free-tier writes low.
  async scheduled(event, env, ctx) {
    if (!env.MAM_KV) return;
    const now = new Date();
    const fixtures = [];
    const seen = new Set();
    const decode = value => String(value || "")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&uuml;/gi, "ü").replace(/&Uuml;/g, "Ü")
      .replace(/&ouml;/gi, "ö").replace(/&Ouml;/g, "Ö")
      .replace(/&ccedil;/gi, "ç").replace(/&Ccedil;/g, "Ç")
      .replace(/&gbreve;/gi, "ğ").replace(/&Gbreve;/g, "Ğ")
      .replace(/&scedil;/gi, "ş").replace(/&Scedil;/g, "Ş")
      .replace(/&inodot;/gi, "ı").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
    const cleanTeam = value => {
      const raw = decode(value).replace(/\s+/g, " ").replace(/\s*\.\s*/g, ".").trim();
      const key = normalizeTeamName(raw).replace(/-a-s$/, "").replace(/-as$/, "");
      const aliases = {
        "galatasaray": "Galatasaray", "fenerbahce": "Fenerbahçe",
        "besiktas": "Beşiktaş", "samsunspor": "Samsunspor",
        "kasimpasa": "Kasımpaşa", "trabzonspor": "Trabzonspor",
        "genclerbirligi": "Gençlerbirliği", "tumosankonyaspor": "Konyaspor",
        "corendon-alanyaspor": "Alanyaspor", "caykur-rizespor": "Çaykur Rizespor",
        "gaziantep-futbol-kulubu": "Gaziantep FK", "amed-sportif-faaliyetler": "Amedspor",
        "arca-corum-fk": "Çorum FK", "erzurumspor-fk": "Erzurum BB",
        "istanbul-basaksehir-fk": "Başakşehir", "goztepe": "Göztepe",
        "eyupspor": "Eyüpspor", "kocaelispor": "Kocaelispor"
      };
      return aliases[key] || raw.replace(/\s+A\.Ş\.$/i, "").trim();
    };
    for (let start = 1; start <= 34; start += 4) {
      const batch = [];
      for (let round = start; round < Math.min(start + 4, 35); round++) {
        batch.push((async () => {
          const response = await fetch("https://www.tff.org/Default.aspx?hafta=" + round + "&pageID=198", {
            headers: { "Accept": "text/html", "User-Agent": "Mozilla/5.0 MaçAnalizMerkezi/1.0" }
          });
          if (!response.ok) throw new Error("TFF hafta " + round + " HTTP " + response.status);
          const html = await response.text();
          const text = decode(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
          const re = /(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}:\d{2})\s+(.+?)\s+-\s+(.+?)(?=\s+Detaylar|\s+\d{2}\.\d{2}\.\d{4}|$)/g;
          let match;
          while ((match = re.exec(text)) !== null) {
            const [, day, month, year, time, homeRaw, awayRaw] = match;
            const home = cleanTeam(homeRaw), away = cleanTeam(awayRaw);
            if (!home || !away || home.length > 70 || away.length > 70) continue;
            const iso = year + "-" + month + "-" + day + "T" + time + ":00+03:00";
            const timestamp = Date.parse(iso);
            if (!Number.isFinite(timestamp) || timestamp < now.getTime() - 3 * 60 * 60 * 1000) continue;
            const id = "tff-" + year + month + day + "-" + normalizeTeamName(home) + "-" + normalizeTeamName(away);
            if (seen.has(id)) continue;
            seen.add(id);
            fixtures.push({
              fixture: { id, date: iso, status: { short: "NS", elapsed: null } },
              league: { id: 203, name: "Trendyol Süper Lig", country: "Türkiye", round: round + ". Hafta" },
              teams: { home: { id: null, name: home }, away: { id: null, name: away } },
              goals: { home: null, away: null },
              _source: "TFF"
            });
          }
        })());
      }
      const results = await Promise.allSettled(batch);
      if (results.some(result => result.status === "rejected")) {
        // Do not replace a valid previous snapshot with a partial scrape.
        throw new Error("TFF fikstür taramasında hafta hatası: " + results.filter(x => x.status === "rejected").map(x => x.reason?.message || "bilinmeyen hata").join("; "));
      }
    }
    fixtures.sort((a, b) => Date.parse(a.fixture.date) - Date.parse(b.fixture.date));
    if (fixtures.length < 9) throw new Error("TFF taramasında beklenen sayıda gelecek maç bulunamadı: " + fixtures.length);
    const snapshot = { source: "TFF", season: "2026/2027", updatedAt: new Date().toISOString(), count: fixtures.length, fixtures };
    await env.MAM_KV.put("superlig:fixtures:2026-27", JSON.stringify(snapshot));
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
      const isFixtureDownload = path.startsWith("fixturesdownload/");
      const validESPNPath = /^espn\/[a-zA-Z0-9._-]+\/(?:scoreboard|summary|standings|teams|teams\/[0-9]+\/schedule)$/.test(path) && ( !path.endsWith("/summary") || /^\d+$/.test(url.searchParams.get("event") || "") );
      const validFixtureDownloadPath = /^fixturesdownload\/(?:champions-league|europa-league|conference-league)-20(?:24|25|26|27)$/.test(path);
      const validStandardPath = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path);

      if (!(isESPN ? validESPNPath : isFixtureDownload ? validFixtureDownloadPath : validStandardPath)) {
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

      if (path === "superlig/fixtures") {
        if (!env.MAM_KV) {
          return new Response(JSON.stringify({ error: "MAM_KV KV binding is missing" }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        const snapshot = await env.MAM_KV.get("superlig:fixtures:2026-27", "json");
        if (!snapshot || !Array.isArray(snapshot.fixtures)) {
          return new Response(JSON.stringify({ error: "TFF fikstür senkronizasyonu henüz çalışmadı" }), {
            status: 503, headers: { ...cors, "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify(snapshot), {
          status: 200, headers: { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" }
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
          : isFixtureDownload
            ? path.slice("fixturesdownload/".length)
            : path;

      const apiKey = isESPN || isFixtureDownload
        ? null
        : isFootballData
          ? env.FOOTBALLDATA_API_KEY
          : env.API_FOOTBALL_KEY;

      // ESPN and public FixtureDownload feeds do not require an API key.
      // Only API-Football and football-data.org require their respective secrets.
      if (!isESPN && !isFixtureDownload && !apiKey) {
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
      const base = isFixtureDownload ? "https://fixturedownload.com/feed/json" : isESPNStandings ? "https://site.api.espn.com/apis/v2/sports/soccer" : isESPN ? ESPN_BASE : isFootballData ? FOOTBALLDATA_BASE : API_BASE;
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

      const upstreamHeaders = (isESPN || isFixtureDownload)
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
