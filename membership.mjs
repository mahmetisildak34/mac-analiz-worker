const encoder = new TextEncoder();
const DAY_TZ = "Europe/Istanbul";
const JWKS_CACHE_MS = 10 * 60 * 1000;
let jwksCache = { url: "", expiresAt: 0, keys: [] };

function decodeBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function decodeJsonPart(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

function audienceIncludes(aud, expected) {
  return Array.isArray(aud) ? aud.includes(expected) : aud === expected;
}

async function getJwks(url, fetcher) {
  const now = Date.now();
  if (jwksCache.url === url && jwksCache.expiresAt > now && jwksCache.keys.length) return jwksCache.keys;
  const response = await fetcher(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Supabase JWKS unavailable");
  const payload = await response.json();
  if (!Array.isArray(payload.keys)) throw new Error("Invalid Supabase JWKS");
  jwksCache = { url, expiresAt: now + JWKS_CACHE_MS, keys: payload.keys };
  return jwksCache.keys;
}

async function verifyJwtSignature(header, signingInput, signature, env, fetcher) {
  if (header.alg === "HS256") {
    if (!env.SUPABASE_JWT_SECRET) return false;
    const key = await crypto.subtle.importKey("raw", encoder.encode(env.SUPABASE_JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    return crypto.subtle.verify("HMAC", key, signature, encoder.encode(signingInput));
  }
  if (!["RS256", "ES256"].includes(header.alg) || !header.kid || !env.SUPABASE_JWKS_URL) return false;
  const keys = await getJwks(env.SUPABASE_JWKS_URL, fetcher);
  const jwk = keys.find(candidate => candidate.kid === header.kid && candidate.alg === header.alg && candidate.use !== "enc");
  if (!jwk) return false;
  const algorithm = header.alg === "RS256"
    ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
    : { name: "ECDSA", namedCurve: "P-256" };
  const key = await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
  const verifyAlgorithm = header.alg === "RS256" ? "RSASSA-PKCS1-v1_5" : { name: "ECDSA", hash: "SHA-256" };
  return crypto.subtle.verify(verifyAlgorithm, key, signature, encoder.encode(signingInput));
}

export async function verifySupabaseAccessToken(token, env, options = {}) {
  const fetcher = options.fetcher || fetch;
  if (typeof token !== "string" || token.length > 8192) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = decodeJsonPart(encodedHeader);
    const claims = decodeJsonPart(encodedPayload);
    if (!claims || typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 128) return null;
    if (!env.SUPABASE_ISSUER || claims.iss !== env.SUPABASE_ISSUER) return null;
    if (!audienceIncludes(claims.aud, "authenticated")) return null;
    const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
    if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds) return null;
    if (Number.isFinite(claims.nbf) && claims.nbf > nowSeconds) return null;
    const verified = await verifyJwtSignature(header, `${encodedHeader}.${encodedPayload}`, decodeBase64Url(encodedSignature), env, fetcher);
    return verified ? claims : null;
  } catch (_) {
    return null;
  }
}

export async function resolveMembership(claims, env) {
  if (!claims?.sub) return { userId: null, role: "FREE", premiumEndsAt: null };
  if (env.MAM_ADMIN_USER_ID && claims.sub === env.MAM_ADMIN_USER_ID) {
    return { userId: claims.sub, role: "ADMIN", premiumEndsAt: null };
  }
  if (!env.DB) return { userId: claims.sub, role: "FREE", premiumEndsAt: null };
  const row = await env.DB.prepare(
    "SELECT tier, starts_at, ends_at FROM mam_memberships WHERE user_id = ? LIMIT 1"
  ).bind(claims.sub).first();
  const now = Date.now();
  if (row?.tier === "PREMIUM" && Date.parse(row.starts_at) <= now && (!row.ends_at || Date.parse(row.ends_at) > now)) {
    return { userId: claims.sub, role: "PREMIUM", premiumEndsAt: row.ends_at || null };
  }
  return { userId: claims.sub, role: "FREE", premiumEndsAt: row?.ends_at || null };
}

export function istanbulDayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DAY_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function recordSuccessfulAnalysis(env, { userId, matchKey, limit = 50, day = istanbulDayKey() }) {
  if (!env.DB || !userId || !matchKey) throw new Error("Analysis ledger unavailable");
  const safeLimit = Math.max(1, Math.min(10000, Math.floor(Number(limit) || 50)));
  const inserted = await env.DB.prepare(
    "INSERT INTO mam_user_daily_analyses (user_id, day_tr, match_key, created_at) " +
    "SELECT ?, ?, ?, CURRENT_TIMESTAMP WHERE " +
    "(SELECT COUNT(*) FROM mam_user_daily_analyses WHERE user_id = ? AND day_tr = ?) < ? " +
    "ON CONFLICT(user_id, day_tr, match_key) DO NOTHING RETURNING match_key"
  ).bind(userId, day, matchKey, userId, day, safeLimit).first();
  if (inserted) return { allowed: true, duplicate: false };
  const existing = await env.DB.prepare(
    "SELECT 1 AS found FROM mam_user_daily_analyses WHERE user_id = ? AND day_tr = ? AND match_key = ? LIMIT 1"
  ).bind(userId, day, matchKey).first();
  if (existing) return { allowed: true, duplicate: true };
  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) AS used FROM mam_user_daily_analyses WHERE user_id = ? AND day_tr = ?"
  ).bind(userId, day).first();
  return { allowed: false, duplicate: false, used: Number(countRow?.used || 0), limit: safeLimit };
}

export function analysisMatchKey({ fixtureId, homeName, awayName, kickoff }) {
  const id = String(fixtureId || "").trim();
  const kickoffMs = Date.parse(String(kickoff || ""));
  let date = "";
  if (Number.isFinite(kickoffMs)) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: DAY_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(kickoffMs));
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    date = `${values.year}-${values.month}-${values.day}`;
  }
  const normalize = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  const home = normalize(homeName), away = normalize(awayName);
  if (date && home && away) return `match:${date}:${home}:${away}`;
  if (id && id.length <= 128) return `fixture:${id}`;
  return null;
}


function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

async function getConfirmedSupabaseUser(claims, token, env, fetcher) {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const endpoint = new URL("/auth/v1/user", env.SUPABASE_URL);
  const response = await fetcher(endpoint, { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } });
  if (!response.ok) return null;
  const user = await response.json();
  if (user?.id !== claims.sub || !(user.email_confirmed_at || user.confirmed_at)) return null;
  return user;
}

export async function handlePremiumAnalysisRequest(request, env, options = {}) {
  const fetcher = options.fetcher || fetch;
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const claims = options.getClaims
    ? await options.getClaims(token, env)
    : await verifySupabaseAccessToken(token, env, { fetcher, now: options.now?.getTime?.() ?? Date.now() });
  if (!claims) return jsonResponse(401, { error: "Geçerli oturum gerekli." });
  const verifiedUser = options.getVerifiedUser
    ? await options.getVerifiedUser(claims, token, env)
    : await getConfirmedSupabaseUser(claims, token, env, fetcher);
  if (!verifiedUser) return jsonResponse(403, { error: "E-posta doğrulaması gerekli." });
  let membership;
  try { membership = await resolveMembership(claims, env); }
  catch (_) { return jsonResponse(503, { error: "Üyelik deposu kullanılamıyor." }); }
  if (membership.role === "FREE") return jsonResponse(403, { error: "Premium analiz üyeliği gerekli.", role: "FREE" });
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > 65536) return jsonResponse(413, { error: "Analiz isteği çok büyük." });
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 65536) return jsonResponse(413, { error: "Analiz isteği çok büyük." });
    body = JSON.parse(raw);
  } catch (_) { return jsonResponse(400, { error: "Geçersiz analiz isteği." }); }
  const { homeName, awayName, kickoff, fixtureId, modelInput, modelType } = body || {};
  if (typeof homeName !== "string" || typeof awayName !== "string" || typeof kickoff !== "string") {
    return jsonResponse(400, { error: "Maç veya model bilgileri eksik." });
  }
  const kickoffMs = Date.parse(kickoff);
  const isLive = modelType === "live-v1";
  if (!Number.isFinite(kickoffMs) || (!isLive && kickoffMs <= (options.now?.getTime?.() ?? Date.now()))) return jsonResponse(400, { error: "Yalnızca analiz edilebilir maçlar kabul edilir." });
  let result;
  try {
    if (isLive) {
      const { calculateLiveV1 } = await import("./analysis-live-v1.mjs");
      result = calculateLiveV1(modelInput || {});
    } else {
      if (!modelInput || typeof modelInput !== "object") return jsonResponse(400, { error: "Maç geçmişi istatistikleri gerekli." });
      const { calculatePrematchV12 } = await import("./analysis-v1-2.mjs");
      result = calculatePrematchV12({ ...modelInput, homeName, awayName });
    }
  }
  catch (error) {
    const insufficient = error instanceof RangeError;
    return jsonResponse(insufficient ? 422 : 400, { error: insufficient ? "Doğrulanmış geçmiş veri yetersiz." : "Analiz girdileri geçersiz." });
  }
  const matchKey = analysisMatchKey({ fixtureId, homeName, awayName, kickoff });
  if (!matchKey) return jsonResponse(400, { error: "Maç kimliği oluşturulamadı." });
  const day = istanbulDayKey(options.now || new Date());
  let quota = { used: 0, limit: null, remaining: null, duplicate: false };
  if (membership.role !== "ADMIN") {
    if (!env.DB) return jsonResponse(503, { error: "Analiz hakkı deposu kullanılamıyor." });
    const configured = Number(env.MAM_PREMIUM_DAILY_LIMIT || 50);
    const limit = Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 50;
    let recorded;
    try { recorded = await recordSuccessfulAnalysis(env, { userId: membership.userId, matchKey, limit, day }); }
    catch (_) { return jsonResponse(503, { error: "Analiz hakkı kaydedilemedi; analiz tamamlanmadı." }); }
    if (!recorded.allowed) return jsonResponse(429, { error: "Günlük analiz hakkı doldu.", used: recorded.used, limit, remaining: 0, day });
    let used = null;
    try {
      const row = await env.DB.prepare("SELECT COUNT(*) AS used FROM mam_user_daily_analyses WHERE user_id = ? AND day_tr = ?").bind(membership.userId, day).first();
      used = Number(row?.used || 0);
    } catch (_) { /* The completed analysis stays successful if display-only quota metadata is unavailable. */ }
    quota = { used, limit, remaining: used === null ? null : Math.max(0, limit - used), duplicate: recorded.duplicate };
  }
  return jsonResponse(200, { ...result, role: membership.role, day, quota });
}


async function verifyTurnstile(token, request, env, fetcher) {
  if (!env.TURNSTILE_SECRET || typeof token !== "string" || token.length < 10 || token.length > 4096) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.set("remoteip", ip);
  try {
    const response = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const result = await response.json();
    return response.ok && result.success === true;
  } catch (_) { return false; }
}

async function proxyAuth(path, query, body, env, fetcher, bearer = "", method = "POST") {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return jsonResponse(503, { error: "Kimlik sağlayıcısı henüz yapılandırılmadı." });
  const endpoint = new URL(`/auth/v1/${path}`, env.SUPABASE_URL);
  if (query) endpoint.search = query;
  const headers = { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json", Accept: "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  let response;
  try {
    response = await fetcher(endpoint, { method, headers, body: JSON.stringify(body) });
  } catch (_) { return jsonResponse(502, { error: "Kimlik sağlayıcısına ulaşılamadı." }); }
  const text = await response.text();
  return new Response(text, { status: response.status, headers: { "Content-Type": response.headers.get("Content-Type") || "application/json; charset=utf-8", "Cache-Control": "no-store" } });
}

async function membershipSummary(request, env, options = {}) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const fetcher = options.fetcher || fetch;
  const claims = options.getClaims ? await options.getClaims(token, env) : await verifySupabaseAccessToken(token, env, { fetcher });
  if (!claims) return jsonResponse(401, { error: "Geçerli oturum gerekli." });
  const user = options.getVerifiedUser ? await options.getVerifiedUser(claims, token, env) : await getConfirmedSupabaseUser(claims, token, env, fetcher);
  if (!user) return jsonResponse(403, { error: "E-posta doğrulaması gerekli." });
  let membership;
  try { membership = await resolveMembership(claims, env); }
  catch (_) { return jsonResponse(503, { error: "Üyelik deposu kullanılamıyor." }); }
  const day = istanbulDayKey();
  const configured = Number(env.MAM_PREMIUM_DAILY_LIMIT || 50);
  const limit = Number.isFinite(configured) ? Math.max(1, Math.floor(configured)) : 50;
  let used = 0;
  if (membership.role !== "ADMIN") {
    if (!env.DB) return jsonResponse(503, { error: "Analiz hakkı deposu kullanılamıyor." });
    const row = await env.DB.prepare("SELECT COUNT(*) AS used FROM mam_user_daily_analyses WHERE user_id = ? AND day_tr = ?").bind(membership.userId, day).first();
    used = Number(row?.used || 0);
  }
  return jsonResponse(200, { role: membership.role, premiumEndsAt: membership.premiumEndsAt, day, quota: membership.role === "ADMIN" ? { unlimited: true } : { used, limit, remaining: Math.max(0, limit - used) } });
}

async function authorizeMembershipRequest(request, env, options = {}) {
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const fetcher = options.fetcher || fetch;
  const claims = options.getClaims ? await options.getClaims(token, env) : await verifySupabaseAccessToken(token, env, { fetcher });
  if (!claims) return { response: jsonResponse(401, { error: "Geçerli oturum gerekli." }) };
  const user = options.getVerifiedUser ? await options.getVerifiedUser(claims, token, env) : await getConfirmedSupabaseUser(claims, token, env, fetcher);
  if (!user) return { response: jsonResponse(403, { error: "E-posta doğrulaması gerekli." }) };
  let membership;
  try { membership = await resolveMembership(claims, env); }
  catch (_) { return { response: jsonResponse(503, { error: "Üyelik deposu kullanılamıyor." }) }; }
  return { claims, user, membership };
}

function normalizeCouponItem(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = String(value.id ?? "").trim(), home = String(value.home ?? "").trim(), away = String(value.away ?? "").trim(), market = String(value.market ?? "").trim();
  const date = String(value.date ?? "").trim();
  const probability = value.probability == null ? null : Number(value.probability);
  const odds = value.odds == null || value.odds === "" ? null : Number(value.odds);
  if (!id || id.length > 128 || !home || home.length > 120 || !away || away.length > 120 || !market || market.length > 120 || date.length > 64) return null;
  if (probability !== null && (!Number.isFinite(probability) || probability < 0 || probability > 1)) return null;
  if (odds !== null && (!Number.isFinite(odds) || odds <= 1 || odds > 100000)) return null;
  return { id, home, away, date, market, probability, odds };
}

async function readCouponItems(env, userId) {
  const row = await env.DB.prepare("SELECT items_json FROM mam_user_coupons WHERE user_id = ? LIMIT 1").bind(userId).first();
  try {
    const parsed = JSON.parse(row?.items_json || "[]");
    return Array.isArray(parsed) ? parsed.map(normalizeCouponItem).filter(Boolean).slice(0, 20) : [];
  } catch (_) { return []; }
}

async function writeCouponItems(env, userId, items) {
  const json = JSON.stringify(items);
  if (json.length > 32768) throw new RangeError("Coupon data too large");
  await env.DB.prepare(
    "INSERT INTO mam_user_coupons (user_id, items_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) " +
    "ON CONFLICT(user_id) DO UPDATE SET items_json = excluded.items_json, updated_at = CURRENT_TIMESTAMP"
  ).bind(userId, json).run();
}

export async function handlePremiumCouponRequest(request, env, options = {}) {
  const auth = await authorizeMembershipRequest(request, env, options);
  if (auth.response) return auth.response;
  if (auth.membership.role === "FREE") return jsonResponse(403, { error: "Kupon oluşturmak için Premium üyelik gerekli.", role: "FREE" });
  if (!env.DB) return jsonResponse(503, { error: "Kupon deposu kullanılamıyor." });
  if (request.method !== "GET" && request.method !== "POST") return jsonResponse(405, { error: "Method not allowed." });
  let items;
  try { items = await readCouponItems(env, auth.membership.userId); }
  catch (_) { return jsonResponse(503, { error: "Kupon deposu okunamadı." }); }
  if (request.method === "GET") return jsonResponse(200, { items, role: auth.membership.role });
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > 32768) return jsonResponse(413, { error: "Kupon isteği çok büyük." });
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 32768) return jsonResponse(413, { error: "Kupon isteği çok büyük." });
    body = JSON.parse(raw);
  } catch (_) { return jsonResponse(400, { error: "Geçersiz kupon isteği." }); }
  const action = body?.action;
  if (action === "build") {
    if (!["safe", "risky"].includes(body.mode) || !Array.isArray(body.candidates) || body.candidates.length > 200) return jsonResponse(400, { error: "Kupon önerisi için geçerli maç listesi gerekli." });
    const safe = body.mode === "safe";
    const pool = body.candidates.map(normalizeCouponItem).filter(item => item && item.probability > 0 && (safe ? item.probability >= .65 : item.probability >= .35 && item.probability < .65))
      .sort((a, b) => safe ? b.probability - a.probability : a.probability - b.probability);
    const picks = [], seen = new Set();
    for (const item of pool) {
      if (seen.has(item.id)) continue;
      seen.add(item.id); picks.push({ ...item, odds: null });
      if (picks.length === (safe ? 10 : 6)) break;
    }
    items = picks;
  } else if (action === "add") {
    const item = normalizeCouponItem(body.item);
    if (!item) return jsonResponse(400, { error: "Geçerli maç ve market seçimi gerekli." });
    const index = items.findIndex(current => current.id === item.id && current.market === item.market);
    if (index >= 0) items[index] = item;
    else if (items.length >= 20) return jsonResponse(413, { error: "Bir kupona en fazla 20 seçim eklenebilir." });
    else items.push(item);
  } else if (action === "remove") {
    if (!Number.isInteger(body.index) || body.index < 0 || body.index >= items.length) return jsonResponse(400, { error: "Kupon seçimi bulunamadı." });
    items.splice(body.index, 1);
  } else if (action === "set-odds") {
    if (!Number.isInteger(body.index) || body.index < 0 || body.index >= items.length) return jsonResponse(400, { error: "Kupon seçimi bulunamadı." });
    const odds = body.odds == null || body.odds === "" ? null : Number(body.odds);
    if (odds !== null && (!Number.isFinite(odds) || odds <= 1 || odds > 100000)) return jsonResponse(400, { error: "Oran 1.00'dan büyük ve en fazla 100000 olmalı." });
    items[body.index] = { ...items[body.index], odds };
  } else if (action === "clear") items = [];
  else return jsonResponse(400, { error: "Bilinmeyen kupon işlemi." });
  try { await writeCouponItems(env, auth.membership.userId, items); }
  catch (error) { return jsonResponse(error instanceof RangeError ? 413 : 503, { error: error instanceof RangeError ? "Kupon verisi çok büyük." : "Kupon kaydedilemedi." }); }
  return jsonResponse(200, { items, role: auth.membership.role });
}

export async function handleAdminMembershipRequest(request, env, options = {}) {
  const auth = await authorizeMembershipRequest(request, env, options);
  if (auth.response) return auth.response;
  if (auth.membership.role !== "ADMIN") return jsonResponse(403, { error: "Yönetici yetkisi gerekli." });
  if (!env.DB) return jsonResponse(503, { error: "Üyelik deposu kullanılamıyor." });
  const url = new URL(request.url);
  if (request.method === "GET") {
    const userId = String(url.searchParams.get("userId") || "");
    if (!userId || userId.length > 128) return jsonResponse(400, { error: "Geçerli kullanıcı kimliği gerekli." });
    try {
      const row = await env.DB.prepare("SELECT tier, starts_at, ends_at FROM mam_memberships WHERE user_id = ? LIMIT 1").bind(userId).first();
      return jsonResponse(200, { userId, tier: row?.tier === "PREMIUM" ? "PREMIUM" : "FREE", startsAt: row?.starts_at || null, endsAt: row?.ends_at || null });
    } catch (_) { return jsonResponse(503, { error: "Üyelik deposu sorgulanamadı." }); }
  }
  if (request.method !== "POST") return jsonResponse(405, { error: "Method not allowed." });
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 8192) return jsonResponse(413, { error: "Yönetici isteği çok büyük." });
    body = JSON.parse(raw);
  } catch (_) { return jsonResponse(400, { error: "Geçersiz yönetici isteği." }); }
  const userId = String(body?.userId || "").trim();
  if (!userId || userId.length > 128 || userId === auth.membership.userId) return jsonResponse(400, { error: "Farklı ve geçerli bir kullanıcı kimliği gerekli." });
  if (body.action === "revoke") {
    try {
      const result = await env.DB.prepare("DELETE FROM mam_memberships WHERE user_id = ?").bind(userId).run();
      if (result?.success === false) throw new Error("D1 delete failed");
    } catch (_) { return jsonResponse(503, { error: "Premium üyelik sonlandırılamadı." }); }
    return jsonResponse(200, { userId, tier: "FREE", endsAt: null });
  }
  if (body.action !== "grant" || (body.endsAt != null && (typeof body.endsAt !== "string" || !Number.isFinite(Date.parse(body.endsAt)) || Date.parse(body.endsAt) <= Date.now()))) {
    return jsonResponse(400, { error: "Grant için geçerli ve gelecekteki bitiş zamanı veya null gerekli." });
  }
  const startsAt = new Date().toISOString();
  try {
    const result = await env.DB.prepare(
      "INSERT INTO mam_memberships (user_id, tier, starts_at, ends_at, updated_at) VALUES (?, 'PREMIUM', ?, ?, CURRENT_TIMESTAMP) " +
      "ON CONFLICT(user_id) DO UPDATE SET tier = 'PREMIUM', starts_at = excluded.starts_at, ends_at = excluded.ends_at, updated_at = CURRENT_TIMESTAMP"
    ).bind(userId, startsAt, body.endsAt || null).run();
    if (result?.success === false) throw new Error("D1 upsert failed");
  } catch (_) { return jsonResponse(503, { error: "Premium üyelik güncellenemedi." }); }
  return jsonResponse(200, { userId, tier: "PREMIUM", startsAt, endsAt: body.endsAt || null });
}

export async function handleMembershipRequest(request, env, options = {}) {
  const url = new URL(request.url);
  const fetcher = options.fetcher || fetch;
  if (url.pathname === "/membership/config" && request.method === "GET") {
    return jsonResponse(200, { configured: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.TURNSTILE_SITE_KEY), turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
  }
  if (url.pathname === "/membership/analysis" && request.method === "POST") return handlePremiumAnalysisRequest(request, env, options);
  if (url.pathname === "/membership/me" && request.method === "GET") return membershipSummary(request, env, options);
  if (url.pathname === "/membership/coupon") return handlePremiumCouponRequest(request, env, options);
  if (url.pathname === "/membership/admin/membership") return handleAdminMembershipRequest(request, env, options);
  if (!url.pathname.startsWith("/membership/auth/") || request.method !== "POST") return jsonResponse(404, { error: "Membership route not found." });
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > 16384) return jsonResponse(413, { error: "Kimlik isteği çok büyük." });
  let body;
  try {
    const raw = await request.text();
    if (raw.length > 16384) return jsonResponse(413, { error: "Kimlik isteği çok büyük." });
    body = JSON.parse(raw);
  } catch (_) { return jsonResponse(400, { error: "Geçersiz kimlik isteği." }); }
  const route = url.pathname.slice("/membership/auth/".length);
  if (["signup", "login", "password-reset"].includes(route)) {
    if (!(await verifyTurnstile(body.turnstileToken, request, env, fetcher))) return jsonResponse(403, { error: "Bot doğrulaması başarısız." });
  }
  if (route === "signup") {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || typeof body.password !== "string" || body.password.length < 12 || body.password.length > 128) return jsonResponse(400, { error: "Geçerli e-posta ve en az 12 karakterli parola gerekli." });
    const data = { email, password: body.password, gotrue_meta_security: { captcha_token: body.turnstileToken } };
    const redirect = env.MAM_EMAIL_REDIRECT_URL ? `redirect_to=${encodeURIComponent(env.MAM_EMAIL_REDIRECT_URL)}` : "";
    return proxyAuth("signup", redirect, data, env, fetcher);
  }
  if (route === "login") {
    if (typeof body.email !== "string" || typeof body.password !== "string") return jsonResponse(400, { error: "E-posta ve parola gerekli." });
    return proxyAuth("token", "grant_type=password", { email: body.email.trim().toLowerCase(), password: body.password, gotrue_meta_security: { captcha_token: body.turnstileToken } }, env, fetcher);
  }
  if (route === "refresh") {
    if (typeof body.refresh_token !== "string" || body.refresh_token.length > 4096) return jsonResponse(400, { error: "Yenileme oturumu geçersiz." });
    return proxyAuth("token", "grant_type=refresh_token", { refresh_token: body.refresh_token }, env, fetcher);
  }
  if (route === "password-reset") {
    if (typeof body.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) return jsonResponse(400, { error: "Geçerli e-posta gerekli." });
    const resetRedirect = env.MAM_PASSWORD_RESET_REDIRECT_URL || env.MAM_EMAIL_REDIRECT_URL;
    const query = resetRedirect ? `redirect_to=${encodeURIComponent(resetRedirect)}` : "";
    return proxyAuth("recover", query, { email: body.email.trim().toLowerCase(), gotrue_meta_security: { captcha_token: body.turnstileToken } }, env, fetcher);
  }
  if (route === "logout") {
    const token = String(body.access_token || "");
    if (!token || token.length > 8192) return jsonResponse(400, { error: "Oturum geçersiz." });
    return proxyAuth("logout", "", {}, env, fetcher, token);
  }
  if (route === "update-password") {
    const token = String(body.access_token || "");
    if (!token || token.length > 8192 || typeof body.password !== "string" || body.password.length < 12 || body.password.length > 128) return jsonResponse(400, { error: "Geçerli oturum ve en az 12 karakterli yeni parola gerekli." });
    return proxyAuth("user", "", { password: body.password }, env, fetcher, token, "PUT");
  }
  return jsonResponse(404, { error: "Membership auth route not found." });
}
