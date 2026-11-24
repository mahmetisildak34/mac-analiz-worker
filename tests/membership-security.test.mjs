import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { analysisMatchKey, handleMembershipRequest, istanbulDayKey, recordSuccessfulAnalysis, resolveMembership, verifySupabaseAccessToken } from "../membership.mjs";

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
