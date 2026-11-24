import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { analysisMatchKey, handleAdminMembershipRequest, handleMembershipRequest, handlePremiumCouponRequest, istanbulDayKey, recordSuccessfulAnalysis, resolveMembership, verifySupabaseAccessToken } from "../membership.mjs";

function tokenFor(claims, secret = "test-only-secret") {
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode({ alg: "HS256", typ: "JWT" });
  const body = encode(claims);
  const input = `${head}.${body}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}

function fakeDb({ limit = 2 } = {}) {
  const rows = new Set();
  return {
    rows,
    prepare(sql) {
      return { bind(...values) { return {
        async first() {
          if (sql.startsWith("INSERT INTO")) {
            const [user, day, match, countUser, countDay, max] = values;
            const key = `${user}|${day}|${match}`;
            if (rows.has(key)) return null;
            const count = [...rows].filter(row => row.startsWith(`${countUser}|${countDay}|`)).length;
            if (count >= max) return null;
            rows.add(key); return { match_key: match };
          }
          if (sql.includes("SELECT 1 AS found")) return rows.has(`${values[0]}|${values[1]}|${values[2]}`) ? { found: 1 } : null;
          if (sql.includes("COUNT(*) AS used")) return { used: [...rows].filter(row => row.startsWith(`${values[0]}|${values[1]}|`)).length };
          if (sql.includes("FROM mam_memberships")) return null;
          return null;
        }
      }; } };
    }
  };
}

const baseClaims = { sub: "user-1", iss: "https://project.test/auth/v1", aud: "authenticated", exp: 2_000_000_000 };
const authEnv = { SUPABASE_ISSUER: baseClaims.iss, SUPABASE_JWT_SECRET: "test-only-secret" };

test("JWT requires signature, issuer, audience, expiry and subject", async () => {
  assert.equal((await verifySupabaseAccessToken(tokenFor(baseClaims), authEnv, { now: 1_900_000_000_000 }))?.sub, "user-1");
  assert.equal(await verifySupabaseAccessToken(tokenFor({ ...baseClaims, iss: "https://wrong" }), authEnv, { now: 1_900_000_000_000 }), null);
  assert.equal(await verifySupabaseAccessToken(tokenFor({ ...baseClaims, aud: "anon" }), authEnv, { now: 1_900_000_000_000 }), null);
  assert.equal(await verifySupabaseAccessToken(tokenFor({ ...baseClaims, exp: 1 }), authEnv, { now: 1_900_000_000_000 }), null);
  const parts = tokenFor(baseClaims).split(".");
  assert.equal(await verifySupabaseAccessToken(`${parts[0]}.${parts[1]}.bad`, authEnv, { now: 1_900_000_000_000 }), null);
});

test("Istanbul day boundary follows Türkiye local midnight", () => {
  assert.equal(istanbulDayKey(new Date("2026-11-24T20:59:59.000Z")), "2026-11-24");
  assert.equal(istanbulDayKey(new Date("2026-11-24T21:00:00.000Z")), "2026-11-25");
});

test("admin identity is server-configured; no client claim grants admin", async () => {
  const claims = { sub: "user-1", role: "ADMIN" };
  assert.equal((await resolveMembership(claims, { MAM_ADMIN_USER_ID: "owner-id" })).role, "FREE");
  assert.equal((await resolveMembership({ ...claims, sub: "owner-id" }, { MAM_ADMIN_USER_ID: "owner-id" })).role, "ADMIN");
});

test("membership defaults to FREE and expired premium does not grant access", async () => {
  const db = { prepare() { return { bind() { return { first: async () => ({ tier: "PREMIUM", starts_at: "2020-01-01T00:00:00Z", ends_at: "2021-01-01T00:00:00Z" }) }; } }; } };
  assert.equal((await resolveMembership({ sub: "user-1" }, { DB: db })).role, "FREE");
});

test("per-user quota is unique per match, allows duplicates and blocks new match at limit", async () => {
  const DB = fakeDb({ limit: 2 }); const env = { DB };
  assert.deepEqual(await recordSuccessfulAnalysis(env, { userId: "u1", matchKey: "m1", limit: 2, day: "2026-11-25" }), { allowed: true, duplicate: false });
  assert.deepEqual(await recordSuccessfulAnalysis(env, { userId: "u1", matchKey: "m1", limit: 2, day: "2026-11-25" }), { allowed: true, duplicate: true });
  assert.deepEqual(await recordSuccessfulAnalysis(env, { userId: "u2", matchKey: "m2", limit: 2, day: "2026-11-25" }), { allowed: true, duplicate: false });
  assert.deepEqual(await recordSuccessfulAnalysis(env, { userId: "u1", matchKey: "m3", limit: 2, day: "2026-11-25" }), { allowed: true, duplicate: false });
  assert.deepEqual(await recordSuccessfulAnalysis(env, { userId: "u1", matchKey: "m4", limit: 2, day: "2026-11-25" }), { allowed: false, duplicate: false, used: 2, limit: 2 });
  assert.deepEqual(await recordSuccessfulAnalysis(env, { userId: "u2", matchKey: "m5", limit: 2, day: "2026-11-25" }), { allowed: true, duplicate: false });
  assert.deepEqual(await recordSuccessfulAnalysis(env, { userId: "u1", matchKey: "m4", limit: 2, day: "2026-11-26" }), { allowed: true, duplicate: false });
});

test("match key normalizes teams and Türkiye-local kickoff across provider IDs", () => {
  assert.equal(analysisMatchKey({ fixtureId: "123", homeName: "A", awayName: "B", kickoff: "2026-11-25T19:00:00Z" }), "match:2026-11-25:a:b");
  assert.equal(analysisMatchKey({ fixtureId: "123" }), "fixture:123");
  assert.equal(analysisMatchKey({ homeName: "İstanbul Başakşehir", awayName: "Fenerbahçe", kickoff: "2026-11-25T19:00:00Z" }), "match:2026-11-25:istanbul-basaksehir:fenerbahce");
  assert.equal(analysisMatchKey({ fixtureId: "other-provider-id", homeName: "A", awayName: "B", kickoff: "2026-11-25T23:00:00Z" }), "match:2026-11-26:a:b");
  assert.equal(analysisMatchKey({ fixtureId: "second-id", homeName: "A", awayName: "B", kickoff: "2026-11-26T00:15:00+03:00" }), "match:2026-11-26:a:b");
  assert.equal(analysisMatchKey({ homeName: "", awayName: "B", kickoff: "" }), null);
});


import { handlePremiumAnalysisRequest } from "../membership.mjs";

function analysisRequest({ fixtureId = "fx-1", kickoff = "2026-11-26T19:00:00Z", homeName = "Home", awayName = "Away" } = {}) {
  return new Request("https://worker.test/membership/analysis", {
    method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify({ fixtureId, kickoff, homeName, awayName, modelInput: analysisStats })
  });
}

const analysisStats = {
  homeOverall: { count: 10, gf: 1.6, ga: 1.1, halfCount: 4, firstGF: 0.8, firstGA: 0.4, secondGF: 0.8, secondGA: 0.7 },
  awayOverall: { count: 10, gf: 1.2, ga: 1.4, halfCount: 4, firstGF: 0.5, firstGA: 0.7, secondGF: 0.7, secondGA: 0.7 },
  homeVenue: { count: 4, gf: 2, ga: 0.8, halfCount: 4, firstGF: 0.8, firstGA: 0.4, secondGF: 1.2, secondGA: 0.4 },
  awayVenue: { count: 4, gf: 0.9, ga: 1.7, halfCount: 4, firstGF: 0.4, firstGA: 0.8, secondGF: 0.5, secondGA: 0.9 }
};

function premiumEnv({ limit = 2 } = {}) {
  const DB = fakeDb();
  const originalPrepare = DB.prepare.bind(DB);
  DB.prepare = sql => {
    if (sql.includes("FROM mam_memberships")) return { bind() { return { first: async () => ({ tier: "PREMIUM", starts_at: "2026-01-01T00:00:00Z", ends_at: "2027-01-01T00:00:00Z" }) }; } };
    return originalPrepare(sql);
  };
  return { DB, MAM_PREMIUM_DAILY_LIMIT: String(limit) };
}

test("Premium API denies missing identity and FREE members server-side", async () => {
  const unauth = await handlePremiumAnalysisRequest(analysisRequest(), {}, { now: new Date("2026-11-24T00:00:00Z") });
  assert.equal(unauth.status, 401);
  const free = await handlePremiumAnalysisRequest(analysisRequest(), { DB: fakeDb() }, {
    getClaims: async () => ({ sub: "free-user" }), getVerifiedUser: async () => ({ id: "free-user", email_confirmed_at: "2026-01-01" }),
    now: new Date("2026-11-24T00:00:00Z")
  });
  assert.equal(free.status, 403);
});

test("Premium API returns server-calculated v1.2 results and allows duplicate fixture without another slot", async () => {
  const env = premiumEnv({ limit: 1 });
  const options = { getClaims: async () => ({ sub: "premium-user" }), getVerifiedUser: async () => ({ id: "premium-user", email_confirmed_at: "2026-01-01" }), now: new Date("2026-11-24T00:00:00Z") };
  const makeRequest = (fixtureId, homeName = "Home") => new Request("https://worker.test/membership/analysis", { method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" }, body: JSON.stringify({ fixtureId, kickoff: "2026-11-26T19:00:00Z", homeName, awayName: "Away", modelInput: analysisStats }) });
  const first = await handlePremiumAnalysisRequest(makeRequest("fx-1"), env, options);
  assert.equal(first.status, 200);
  const firstJson = await first.json();
  assert.equal(firstJson.model, "poisson-v1.2");
  assert.equal(firstJson.quota.remaining, 0);
  const duplicate = await handlePremiumAnalysisRequest(makeRequest("fx-1"), env, options);
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).quota.duplicate, true);
  const second = await handlePremiumAnalysisRequest(makeRequest("fx-2", "Different Home"), env, options);
  assert.equal(second.status, 429);
});

test("Premium API calculates live model on Worker", async () => {
  const env = premiumEnv({ limit: 1 });
  const options = { getClaims: async () => ({ sub: "premium-user" }), getVerifiedUser: async () => ({ id: "premium-user", email_confirmed_at: "2026-01-01" }), now: new Date("2026-11-24T00:00:00Z") };
  const input = { minute: 45, homeScore: 1, awayScore: 0, home: { sot: 3, shots: 8, possession: 55, corners: 4, redCards: 0, xg: .9 }, away: { sot: 2, shots: 6, possession: 45, corners: 2, redCards: 0, xg: .4 } };
  const request = new Request("https://worker.test/membership/analysis", { method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" }, body: JSON.stringify({ modelType: "live-v1", fixtureId: "provider-1", kickoff: "2026-11-24T00:00:00Z", homeName: "H", awayName: "A", modelInput: input }) });
  const response = await handlePremiumAnalysisRequest(request, env, options);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.model, "live-v1");
  assert.equal(result.minute, 45);
  assert.equal(result.quota.remaining, 0);
});

test("quota display read failure does not turn a completed analysis into an error", async () => {
  const env = premiumEnv({ limit: 1 });
  const originalPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = sql => sql.startsWith("SELECT COUNT(*) AS used")
    ? { bind() { return { first: async () => { throw new Error("display query failure"); } }; } }
    : originalPrepare(sql);
  const options = { getClaims: async () => ({ sub: "premium-user" }), getVerifiedUser: async () => ({ id: "premium-user", email_confirmed_at: "2026-01-01" }), now: new Date("2026-11-24T00:00:00Z") };
  const response = await handlePremiumAnalysisRequest(analysisRequest(), env, options);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).quota.remaining, null);
  assert.equal(env.DB.rows.size, 1);
});

test("failed model validation does not spend a daily slot", async () => {
  const env = premiumEnv({ limit: 1 });
  const options = { getClaims: async () => ({ sub: "premium-user" }), getVerifiedUser: async () => ({ id: "premium-user", email_confirmed_at: "2026-01-01" }), now: new Date("2026-11-24T00:00:00Z") };
  const invalid = new Request("https://worker.test/membership/analysis", { method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" }, body: JSON.stringify({ fixtureId: "bad", kickoff: "2026-11-26T19:00:00Z", homeName: "H", awayName: "A", modelInput: { ...analysisStats, homeOverall: { ...analysisStats.homeOverall, count: 2 } } }) });
  const failed = await handlePremiumAnalysisRequest(invalid, env, options);
  assert.equal(failed.status, 422);
  const good = await handlePremiumAnalysisRequest(new Request("https://worker.test/membership/analysis", { method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" }, body: JSON.stringify({ fixtureId: "good", kickoff: "2026-11-26T19:00:00Z", homeName: "H", awayName: "A", modelInput: analysisStats }) }), env, options);
  assert.equal(good.status, 200);
});


test("signup requires server-verified Turnstile before any Supabase Auth request", async () => {
  let providerCalls = 0;
  const env = { SUPABASE_URL: "https://project.test", SUPABASE_ANON_KEY: "test-public-anon", TURNSTILE_SECRET: "test-only-turnstile" };
  const fetcher = async url => {
    if (String(url).includes("siteverify")) return new Response(JSON.stringify({ success: false }), { status: 200 });
    providerCalls++;
    return new Response("{}", { status: 200 });
  };
  const response = await handleMembershipRequest(new Request("https://worker.test/membership/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "test@example.com", password: "very-long-test-password", turnstileToken: "invalid-token-value" }) }), env, { fetcher });
  assert.equal(response.status, 403);
  assert.equal(providerCalls, 0);
});

test("signup validates Turnstile once and proxies credentials server-side", async () => {
  const calls = [];
  const env = { SUPABASE_URL: "https://project.test", SUPABASE_ANON_KEY: "test-anon-key", TURNSTILE_SECRET: "test-turnstile-secret" };
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("siteverify")) return new Response(JSON.stringify({ success: true }), { status: 200 });
    return new Response(JSON.stringify({ id: "signup-pending-email-confirmation" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const response = await handleMembershipRequest(new Request("https://worker.test/membership/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: " User@Example.com ", password: "very-long-test-password", turnstileToken: "valid-test-token-123" }) }), env, { fetcher });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /^https:\/\/project\.test\/auth\/v1\/signup/);
  assert.equal(calls[1].init.headers.apikey, "test-anon-key");
  const submitted = JSON.parse(calls[1].init.body);
  assert.equal(submitted.email, "user@example.com");
  assert.equal(submitted.password, "very-long-test-password");
  assert.equal(submitted.gotrue_meta_security.captcha_token, "valid-test-token-123");
});

test("login and password recovery send Supabase's nested Turnstile token field", async () => {
  const calls = [];
  const env = { SUPABASE_URL: "https://project.test", SUPABASE_ANON_KEY: "anon", TURNSTILE_SECRET: "secret", MAM_PASSWORD_RESET_REDIRECT_URL: "https://app.example.test/reset" };
  const fetcher = async (url, init = {}) => {
    if (String(url).includes("siteverify")) return new Response(JSON.stringify({ success: true }), { status: 200 });
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response("{}", { status: 200 });
  };
  for (const [route, payload] of [
    ["login", { email: "user@example.com", password: "test-password", turnstileToken: "test-captcha-login" }],
    ["password-reset", { email: "user@example.com", turnstileToken: "test-captcha-reset" }]
  ]) {
    const response = await handleMembershipRequest(new Request(`https://worker.test/membership/auth/${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }), env, { fetcher });
    assert.equal(response.status, 200);
  }
  assert.match(calls[0].url, /\/auth\/v1\/token\?grant_type=password$/);
  assert.equal(calls[0].body.gotrue_meta_security.captcha_token, "test-captcha-login");
  assert.equal(new URL(calls[1].url).pathname, "/auth/v1/recover");
  assert.equal(new URL(calls[1].url).searchParams.get("redirect_to"), "https://app.example.test/reset");
  assert.equal(calls[1].body.gotrue_meta_security.captcha_token, "test-captcha-reset");
});

test("auth proxy rejects oversized declared body before provider call", async () => {
  let called = false;
  const request = new Request("https://worker.test/membership/auth/refresh", { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "20000" }, body: JSON.stringify({ refresh_token: "x" }) });
  const response = await handleMembershipRequest(request, { SUPABASE_URL: "https://project.test", SUPABASE_ANON_KEY: "anon" }, { fetcher: async () => { called = true; return new Response("{}"); } });
  assert.equal(response.status, 413);
  assert.equal(called, false);
});

test("password update requires a bearer session and uses Supabase's authenticated user update", async () => {
  let call;
  const env = { SUPABASE_URL: "https://project.test", SUPABASE_ANON_KEY: "anon" };
  const fetcher = async (url, init) => { call = { url: String(url), init }; return new Response(JSON.stringify({ id: "user-1" }), { status: 200 }); };
  const short = await handleMembershipRequest(new Request("https://worker.test/membership/auth/update-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: "test-access", password: "short" }) }), env, { fetcher });
  assert.equal(short.status, 400);
  assert.equal(call, undefined);
  const response = await handleMembershipRequest(new Request("https://worker.test/membership/auth/update-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: "test-access", password: "long-enough-test-password" }) }), env, { fetcher });
  assert.equal(response.status, 200);
  assert.equal(call.url, "https://project.test/auth/v1/user");
  assert.equal(call.init.method, "PUT");
  assert.equal(call.init.headers.Authorization, "Bearer test-access");
  assert.equal(JSON.parse(call.init.body).password, "long-enough-test-password");
});

test("public auth config never returns Supabase credentials", async () => {
  const response = await handleMembershipRequest(new Request("https://worker.test/membership/config"), { SUPABASE_URL: "https://project.test", SUPABASE_ANON_KEY: "must-not-return", TURNSTILE_SITE_KEY: "site-key" });
  const body = await response.json();
  assert.equal(body.configured, true);
  assert.equal(body.turnstileSiteKey, "site-key");
  assert.equal(JSON.stringify(body).includes("must-not-return"), false);
  assert.equal(JSON.stringify(body).includes("project.test"), false);
});

function serviceDb() {
  const memberships = new Map(), coupons = new Map();
  return {
    memberships, coupons,
    prepare(sql) { return { bind(...values) { return {
      async first() {
        if (sql.includes("FROM mam_memberships")) return memberships.get(values[0]) || null;
        if (sql.includes("FROM mam_user_coupons")) return coupons.has(values[0]) ? { items_json: coupons.get(values[0]) } : null;
        return null;
      },
      async run() {
        if (sql.startsWith("INSERT INTO mam_user_coupons")) coupons.set(values[0], values[1]);
        else if (sql.startsWith("DELETE FROM mam_memberships")) memberships.delete(values[0]);
        else if (sql.startsWith("INSERT INTO mam_memberships")) memberships.set(values[0], { tier: "PREMIUM", starts_at: values[1], ends_at: values[2] });
        return { success: true };
      }
    }; } }; }
  };
}

function identityOptions(userId, tokenRole) {
  return {
    getClaims: async () => ({ sub: userId, role: tokenRole }),
    getVerifiedUser: async () => ({ id: userId, email_confirmed_at: "2026-01-01T00:00:00Z" })
  };
}

test("coupon endpoint denies FREE direct requests and stores Premium builds per authenticated user", async () => {
  const DB = serviceDb(), env = { DB, MAM_ADMIN_USER_ID: "admin-1" };
  const body = { action: "build", mode: "safe", candidates: [
    { id: "m1", home: "Home", away: "Away", market: "1X", date: "2026-11-26", probability: .8 },
    { id: "m1", home: "Home", away: "Away", market: "Over 1.5", date: "2026-11-26", probability: .9 },
    { id: "m2", home: "Other", away: "Guest", market: "1X", date: "2026-11-26", probability: .7 },
    { id: "m3", home: "Third", away: "Fourth", market: "1X", date: "2026-11-26", probability: .64 }
  ] };
  const request = userId => new Request("https://worker.test/membership/coupon", { method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const free = await handlePremiumCouponRequest(request("free-1"), env, identityOptions("free-1", "ADMIN"));
  assert.equal(free.status, 403);
  assert.equal(DB.coupons.size, 0);
  DB.memberships.set("premium-1", { tier: "PREMIUM", starts_at: "2026-01-01T00:00:00Z", ends_at: "2030-01-01T00:00:00Z" });
  const built = await handlePremiumCouponRequest(request("premium-1"), env, identityOptions("premium-1"));
  assert.equal(built.status, 200);
  const result = await built.json();
  assert.deepEqual(result.items.map(item => item.id), ["m1", "m2"]);
  assert.equal(result.items[0].market, "Over 1.5");
  const read = await handlePremiumCouponRequest(new Request("https://worker.test/membership/coupon", { headers: { Authorization: "Bearer test-token" } }), env, identityOptions("premium-1"));
  assert.deepEqual((await read.json()).items, result.items);
  const outsider = await handlePremiumCouponRequest(new Request("https://worker.test/membership/coupon", { headers: { Authorization: "Bearer test-token" } }), env, identityOptions("free-2"));
  assert.equal(outsider.status, 403);
});

test("coupon endpoint bounds candidates, item fields, and stored selections", async () => {
  const DB = serviceDb(), env = { DB };
  DB.memberships.set("premium-user", { tier: "PREMIUM", starts_at: "2026-01-01T00:00:00Z", ends_at: "2030-01-01T00:00:00Z" });
  const post = payload => handlePremiumCouponRequest(new Request("https://worker.test/membership/coupon", { method: "POST", headers: { Authorization: "Bearer token", "Content-Type": "application/json" }, body: JSON.stringify(payload) }), env, identityOptions("premium-user"));
  const excessiveCandidates = await post({ action: "build", mode: "safe", candidates: Array.from({ length: 201 }, (_, i) => ({ id: String(i), home: "H", away: "A", market: "1X", probability: .8 })) });
  assert.equal(excessiveCandidates.status, 400);
  const oversizedField = await post({ action: "add", item: { id: "m", home: "H".repeat(121), away: "A", market: "1X" } });
  assert.equal(oversizedField.status, 400);
  const seeded = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, home: "H", away: "A", market: "1X", date: "2026-11-26", probability: .8, odds: null }));
  DB.coupons.set("premium-user", JSON.stringify(seeded));
  const overflow = await post({ action: "add", item: { id: "extra", home: "H", away: "A", market: "1X" } });
  assert.equal(overflow.status, 413);
  assert.equal(JSON.parse(DB.coupons.get("premium-user")).length, 20);
});

test("admin membership API ignores client role claims and permits only configured admin to grant or revoke Premium", async () => {
  const DB = serviceDb(), env = { DB, MAM_ADMIN_USER_ID: "verified-admin" };
  const forged = identityOptions("ordinary-user", "ADMIN");
  const denied = await handleAdminMembershipRequest(new Request("https://worker.test/membership/admin/membership?userId=target", { headers: { Authorization: "Bearer token" } }), env, forged);
  assert.equal(denied.status, 403);
  const admin = identityOptions("verified-admin", "FREE");
  const grant = () => handleAdminMembershipRequest(new Request("https://worker.test/membership/admin/membership", { method: "POST", headers: { Authorization: "Bearer token", "Content-Type": "application/json" }, body: JSON.stringify({ action: "grant", userId: "target-user", endsAt: "2030-01-01T00:00:00.000Z" }) }), env, admin);
  const granted = await grant();
  assert.equal(granted.status, 200);
  assert.equal((await resolveMembership({ sub: "target-user" }, env)).role, "PREMIUM");
  const status = await handleAdminMembershipRequest(new Request("https://worker.test/membership/admin/membership?userId=target-user", { headers: { Authorization: "Bearer token" } }), env, admin);
  assert.equal((await status.json()).tier, "PREMIUM");
  const selfGrant = await handleAdminMembershipRequest(new Request("https://worker.test/membership/admin/membership", { method: "POST", headers: { Authorization: "Bearer token", "Content-Type": "application/json" }, body: JSON.stringify({ action: "grant", userId: "verified-admin" }) }), env, admin);
  assert.equal(selfGrant.status, 400);
  const revoked = await handleAdminMembershipRequest(new Request("https://worker.test/membership/admin/membership", { method: "POST", headers: { Authorization: "Bearer token", "Content-Type": "application/json" }, body: JSON.stringify({ action: "revoke", userId: "target-user" }) }), env, admin);
  assert.equal(revoked.status, 200);
  assert.equal((await resolveMembership({ sub: "target-user" }, env)).role, "FREE");
});

test("admin membership API returns 503 instead of throwing when target membership D1 operations fail", async () => {
  const DB = serviceDb(), env = { DB, MAM_ADMIN_USER_ID: "verified-admin" }, admin = identityOptions("verified-admin");
  const basePrepare = DB.prepare.bind(DB);
  DB.prepare = sql => {
    const statement = basePrepare(sql);
    return { bind(...values) {
      const bound = statement.bind(...values);
      return {
        async first() {
          if (sql.includes("FROM mam_memberships") && values[0] === "target-user") throw new Error("simulated D1 read failure");
          return bound.first();
        },
        async run() {
          if (sql.includes("mam_memberships") && values[0] === "target-user") throw new Error("simulated D1 write failure");
          return bound.run();
        }
      };
    } };
  };
  const status = await handleAdminMembershipRequest(new Request("https://worker.test/membership/admin/membership?userId=target-user", { headers: { Authorization: "Bearer token" } }), env, admin);
  assert.equal(status.status, 503);
  const grant = await handleAdminMembershipRequest(new Request("https://worker.test/membership/admin/membership", { method: "POST", headers: { Authorization: "Bearer token", "Content-Type": "application/json" }, body: JSON.stringify({ action: "grant", userId: "target-user" }) }), env, admin);
  assert.equal(grant.status, 503);
  const revoke = await handleAdminMembershipRequest(new Request("https://worker.test/membership/admin/membership", { method: "POST", headers: { Authorization: "Bearer token", "Content-Type": "application/json" }, body: JSON.stringify({ action: "revoke", userId: "target-user" }) }), env, admin);
  assert.equal(revoke.status, 503);
});


test("concurrent distinct analysis requests cannot exceed the configured fake-D1 quota", async () => {
  const DB = fakeDb({ limit: 5 });
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => recordSuccessfulAnalysis({ DB }, { userId: "parallel-user", matchKey: `match-${index}`, limit: 5, day: "2026-11-25" })));
  assert.equal(results.filter(result => result.allowed && !result.duplicate).length, 5);
  assert.equal(results.filter(result => !result.allowed).length, 15);
  assert.equal(DB.rows.size, 5);
});

test("Supabase email confirmation is required before membership, analysis, or coupon access", async () => {
  const DB = fakeDb();
  const env = { ...authEnv, DB, SUPABASE_URL: "https://project.test", SUPABASE_ANON_KEY: "test-anon" };
  let confirmed = false;
  const fetcher = async () => new Response(JSON.stringify({ id: baseClaims.sub, email_confirmed_at: confirmed ? "2026-01-01T00:00:00Z" : null, confirmed_at: null }), { status: 200, headers: { "Content-Type": "application/json" } });
  const token = tokenFor(baseClaims);
  const options = { fetcher };
  const requests = [
    new Request("https://worker.test/membership/me", { headers: { Authorization: `Bearer ${token}` } }),
    new Request("https://worker.test/membership/analysis", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ fixtureId: "unverified", kickoff: "2026-11-26T19:00:00Z", homeName: "Home", awayName: "Away", modelInput: analysisStats }) }),
    new Request("https://worker.test/membership/coupon", { headers: { Authorization: `Bearer ${token}` } })
  ];
  for (const request of requests) {
    const response = await handleMembershipRequest(request, env, options);
    assert.equal(response.status, 403, new URL(request.url).pathname);
    assert.match((await response.json()).error, /E-posta doğrulaması gerekli/);
  }
  assert.equal(DB.rows.size, 0);
  confirmed = true;
  const verified = await handleMembershipRequest(new Request("https://worker.test/membership/me", { headers: { Authorization: `Bearer ${token}` } }), env, options);
  assert.equal(verified.status, 200);
  assert.equal((await verified.json()).role, "FREE");
});

test("missing, expired, and reused Turnstile tokens fail closed before Supabase Auth", async () => {
  const env = { SUPABASE_URL: "https://project.test", SUPABASE_ANON_KEY: "test-anon", TURNSTILE_SECRET: "test-only-secret" };
  let siteverifyCalls = 0, providerCalls = 0;
  const fetcher = async url => {
    if (String(url).includes("siteverify")) {
      siteverifyCalls++;
      return new Response(JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] }), { status: 200 });
    }
    providerCalls++;
    return new Response("{}", { status: 200 });
  };
  for (const token of [null, "expired-test-token-123", "reused-test-token-123"]) {
    const body = { email: "test@example.com", password: "very-long-test-password", ...(token ? { turnstileToken: token } : {}) };
    const before = siteverifyCalls;
    const response = await handleMembershipRequest(new Request("https://worker.test/membership/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), env, { fetcher });
    assert.equal(response.status, 403);
    assert.equal(siteverifyCalls, before + (token ? 1 : 0));
    assert.equal(providerCalls, 0);
  }
});

test("refresh and logout proxy session tokens to the expected Supabase Auth routes", async () => {
  const calls = [];
  const env = { SUPABASE_URL: "https://project.test", SUPABASE_ANON_KEY: "test-anon" };
  const fetcher = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ access_token: "refreshed-access", refresh_token: "rotated-refresh" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const refresh = await handleMembershipRequest(new Request("https://worker.test/membership/auth/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: "old-refresh" }) }), env, { fetcher });
  assert.equal(refresh.status, 200);
  assert.deepEqual(await refresh.json(), { access_token: "refreshed-access", refresh_token: "rotated-refresh" });
  assert.match(calls[0].url, /\/auth\/v1\/token\?grant_type=refresh_token$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { refresh_token: "old-refresh" });
  const logout = await handleMembershipRequest(new Request("https://worker.test/membership/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: "refreshed-access" }) }), env, { fetcher });
  assert.equal(logout.status, 200);
  assert.equal(new URL(calls[1].url).pathname, "/auth/v1/logout");
  assert.equal(calls[1].init.headers.Authorization, "Bearer refreshed-access");
});

test("users behind the same IP retain separate per-account analysis quotas", async () => {
  const env = premiumEnv({ limit: 1 });
  for (const userId of ["household-user-a", "household-user-b"]) {
    const request = new Request("https://worker.test/membership/analysis", { method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.42" }, body: JSON.stringify({ fixtureId: userId, kickoff: "2026-11-26T19:00:00Z", homeName: "Shared Home Fixture", awayName: "Shared Away Fixture", modelInput: analysisStats }) });
    const response = await handlePremiumAnalysisRequest(request, env, { getClaims: async () => ({ sub: userId }), getVerifiedUser: async () => ({ id: userId, email_confirmed_at: "2026-01-01T00:00:00Z" }), now: new Date("2026-11-24T00:00:00Z") });
    assert.equal(response.status, 200, userId);
  }
  assert.equal(env.DB.rows.size, 2);
});

test("quota-rejected Premium analysis makes no upstream fetch and writes no extra ledger row", async () => {
  const env = premiumEnv({ limit: 1 });
  let upstreamCalls = 0;
  const options = { getClaims: async () => ({ sub: "premium-user" }), getVerifiedUser: async () => ({ id: "premium-user", email_confirmed_at: "2026-01-01T00:00:00Z" }), now: new Date("2026-11-24T00:00:00Z"), fetcher: async () => { upstreamCalls++; throw new Error("unexpected upstream request"); } };
  const first = await handlePremiumAnalysisRequest(analysisRequest({ fixtureId: "quota-first" }), env, options);
  const denied = await handlePremiumAnalysisRequest(analysisRequest({ fixtureId: "quota-second", homeName: "Different Home" }), env, options);
  assert.equal(first.status, 200);
  assert.equal(denied.status, 429);
  assert.equal(upstreamCalls, 0);
  assert.equal(env.DB.rows.size, 1);
});

test("configured ADMIN can use the Premium coupon API without a client admin claim", async () => {
  const DB = serviceDb(), env = { DB, MAM_ADMIN_USER_ID: "configured-admin" };
  const request = new Request("https://worker.test/membership/coupon", { method: "POST", headers: { Authorization: "Bearer token", "Content-Type": "application/json" }, body: JSON.stringify({ action: "build", mode: "safe", candidates: [{ id: "admin-match", home: "Home", away: "Away", market: "1X", date: "2026-11-26", probability: 0.8 }] }) });
  const response = await handlePremiumCouponRequest(request, env, identityOptions("configured-admin", "FREE"));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.role, "ADMIN");
  assert.equal(result.items[0].id, "admin-match");
});

test("configured ADMIN analysis skips the daily quota ledger", async () => {
  const DB = fakeDb({ limit: 1 });
  const response = await handlePremiumAnalysisRequest(analysisRequest(), { DB, MAM_ADMIN_USER_ID: "admin-user", MAM_PREMIUM_DAILY_LIMIT: "1" }, {
    getClaims: async () => ({ sub: "admin-user" }),
    getVerifiedUser: async () => ({ id: "admin-user", email_confirmed_at: "2026-01-01" }),
    now: new Date("2026-11-24T00:00:00Z")
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).role, "ADMIN");
  assert.equal(DB.rows.size, 0);
});
