const inFlight = new Map();

/**
 * Coalesce identical GET work within one Worker isolate.
 * Every caller receives an independent Response body and its own CORS headers.
 * Rejections are never cached; the key is removed after the shared promise settles.
 */
export async function coalesceResponse(key, loader, corsHeaders = {}) {
  if (typeof key !== "string" || !key || typeof loader !== "function") {
    throw new TypeError("Invalid in-flight request key or loader");
  }
  let pending = inFlight.get(key);
  if (!pending) {
    pending = Promise.resolve().then(loader);
    inFlight.set(key, pending);
  }
  try {
    const response = await pending;
    if (!(response instanceof Response)) throw new TypeError("Coalesced loader must return a Response");
    const copy = response.clone();
    const headers = new Headers(copy.headers);
    for (const [name, value] of Object.entries(corsHeaders || {})) {
      if (value != null) headers.set(name, String(value));
    }
    return new Response(copy.body, {
      status: copy.status,
      statusText: copy.statusText,
      headers
    });
  } finally {
    if (inFlight.get(key) === pending) inFlight.delete(key);
  }
}
