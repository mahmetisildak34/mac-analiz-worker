const ALLOWED_ORIGIN = "https://mahmetisildak34.github.io";
const API_BASE = "https://v3.football.api-sports.io";
const FOOTBALLDATA_BASE = "https://api.football-data.org/v4";
const CACHE_SECONDS = 43200;
const STANDINGS_CACHE_SECONDS = 300;

export default {
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

      if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path)) {
        return new Response("Invalid API path", {
          status: 400,
          headers: cors
        });
      }

      const isFootballData = path.startsWith("football-data/");
      const apiPath = isFootballData
        ? path.slice("football-data/".length)
        : path;

      const apiKey = isFootballData
        ? env.FOOTBALLDATA_API_KEY
        : env.API_FOOTBALL_KEY;

      if (!apiKey) {
        return new Response(JSON.stringify({
          error: isFootballData
            ? "FOOTBALLDATA_API_KEY secret is missing"
            : "API_FOOTBALL_KEY secret is missing"
        }), {
          status: 500,
          headers: { ...cors, "Content-Type": "application/json" }
        });
      }

      const base = isFootballData ? FOOTBALLDATA_BASE : API_BASE;
      const targetUrl = base + "/" + apiPath + url.search;
      const isStandings = /(^|\/)standings$/.test(apiPath);
      const cacheUrl = new URL(url.toString());
      // Yeni anahtar, önceki 12 saatlik puan tablosu kayıtlarını devre dışı bırakır.
      if (isStandings) cacheUrl.searchParams.set("__mam_cache", "standings-v2");
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

      const upstreamHeaders = isFootballData
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

      if (upstream.ok && cache) {
        const cacheHeaders = new Headers(response.headers);
        cacheHeaders.set("Cache-Control", "public, max-age=" + (isStandings ? STANDINGS_CACHE_SECONDS : CACHE_SECONDS));

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
