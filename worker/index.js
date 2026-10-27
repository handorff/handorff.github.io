// Standalone module: also deployable through Cloudflare's dashboard editor.
const UPSTREAM = "https://api-v3.mbta.com";
const JSON_API = "application/vnd.api+json";
const ROUTE_FIELDS = "color,sort_order,short_name,long_name";
const ENDPOINTS = {
  "/vehicles": { ttl: 10, stale: 60, params: {
    "page[limit]": "1000",
    "fields[vehicle]": "latitude,longitude,current_status,destination,route,stop,trip",
    include: "route,stop,trip", "fields[route]": ROUTE_FIELDS,
    "fields[stop]": "name", "fields[trip]": "headsign"
  } },
  "/routes": { ttl: 3600, stale: 3600, params: {
    "page[limit]": "1000", "fields[route]": ROUTE_FIELDS
  } },
  "/stops": { ttl: 86400, stale: 3600, ids: true, params: {
    "page[limit]": "1000", "fields[stop]": "name"
  } },
  "/trips": { ttl: 21600, stale: 3600, ids: true, params: {
    "page[limit]": "1000", include: "shape",
    "fields[trip]": "headsign,shape", "fields[shape]": "polyline"
  } }
};

function allowedOrigin(origin) {
  if (["https://paulhandorff.com", "https://www.paulhandorff.com", "https://handorff.github.io"].includes(origin)) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  } catch { return false; }
}

function canonicalUrl(url, config) {
  if (url.search.length > 8000) throw new Error("Query too long");
  for (const [key, value] of url.searchParams) {
    if (key === "filter[id]" && config.ids) continue;
    if (config.params[key] !== value || url.searchParams.getAll(key).length !== 1) {
      throw new Error("Unsupported query parameter");
    }
  }
  const upstream = new URL(url.pathname, UPSTREAM);
  for (const [key, value] of Object.entries(config.params)) upstream.searchParams.set(key, value);
  if (config.ids) {
    const ids = [...new Set((url.searchParams.get("filter[id]") || "").split(","))].sort();
    if (url.searchParams.getAll("filter[id]").length !== 1 || ids.length > 50 ||
        ids.some(id => !/^[A-Za-z0-9_.:-]{1,128}$/.test(id))) throw new Error("Invalid IDs");
    upstream.searchParams.set("filter[id]", ids.join(","));
  }
  return upstream;
}

function retrySeconds(response, now) {
  const retry = response.headers.get("retry-after");
  const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
  const retryAt = retry === null ? 0 : Number.isFinite(Number(retry))
    ? now + Number(retry) * 1000 : Date.parse(retry);
  return Math.min(3600, Math.max(60, Math.ceil((Math.max(reset || 0, retryAt || 0) - now) / 1000)));
}

export function createProxy({ fetchImpl = fetch, now = Date.now, budgetMs = 10_000,
  writeBudgetMs = 2_000, log = event => console.log(JSON.stringify(event)) } = {}) {
  // Only plain timestamps cross request boundaries; never share promises or Responses.
  let cooldownUntil = 0;
  return async function handle(request, env, cache, ctx) {
    const origin = request.headers.get("Origin");
    const respond = (body, status = 200, headers = {}) => {
      const result = new Response(body, { status, headers });
      result.headers.set("Cache-Control", "no-store");
      result.headers.set("Vary", "Origin");
      result.headers.set("X-Content-Type-Options", "nosniff");
      if (origin && allowedOrigin(origin)) {
        result.headers.set("Access-Control-Allow-Origin", origin);
        result.headers.set("Access-Control-Expose-Headers", "X-Data-Fetched-At, X-Proxy-Cache, Retry-After");
      }
      return result;
    };
    if (origin && !allowedOrigin(origin)) return respond("Origin not allowed", 403);
    if (!["GET", "OPTIONS"].includes(request.method)) return respond("Method not allowed", 405, { Allow: "GET, OPTIONS" });
    const url = new URL(request.url);
    const config = ENDPOINTS[url.pathname];
    if (!config) return respond("Not found", 404);
    if (request.method === "OPTIONS") return respond(null, 204, {
      "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Accept",
      "Access-Control-Max-Age": "86400"
    });
    let upstream;
    try { upstream = canonicalUrl(url, config); }
    catch { return respond("Invalid request parameters", 400); }
    if (!env.MBTA_API_KEY) return respond("Backend is not configured", 503);

    // Versioned, canonical cache keys contain neither secrets nor client-specific headers.
    const key = new Request(`${url.origin}/_cache/v1${upstream.pathname}${upstream.search}`);
    const cooldownKey = new Request(`${url.origin}/_cache/v1/cooldown`);
    const started = now();
    const controller = new AbortController();
    let stage = "cache_lookup";
    const diagnostic = (event, extra = {}) => log({ event, path: url.pathname, stage,
      elapsedMs: now() - started, ...extra });
    const cancel = () => controller.abort(new Error("Client canceled"));
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new Error("Operation deadline")), budgetMs);
    // Race every I/O operation, including APIs that may ignore AbortSignal.
    const run = async (name, operation) => {
      stage = name;
      controller.signal.throwIfAborted();
      let rejectAbort;
      const aborted = new Promise((_, reject) => {
        rejectAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      try { return await Promise.race([operation(), aborted]); }
      finally { controller.signal.removeEventListener("abort", rejectAbort); }
    };
    const write = (cacheKey, response, kind) => {
      // Background writes have their own bound and never reject the response.
      const job = (async () => {
        let writeTimer;
        try {
          await Promise.race([cache.put(cacheKey, response), new Promise((_, reject) => {
            writeTimer = setTimeout(() => reject(new Error("Cache write deadline")), writeBudgetMs);
          })]);
        } catch {
          diagnostic("cache_write_failed", { kind });
        } finally { clearTimeout(writeTimer); }
      })();
      ctx.waitUntil(job);
    };
    let cachedBody, fetchedAt = 0;
    const serve = (body, fetched, state) => respond(body, 200, {
      "Content-Type": JSON_API, "X-Data-Fetched-At": String(fetched), "X-Proxy-Cache": state
    });
    const fail = (status, retry = 60) => {
      const age = (now() - fetchedAt) / 1000;
      if (cachedBody !== undefined && age >= 0 && age < config.ttl + config.stale) {
        return serve(cachedBody, fetchedAt, "STALE");
      }
      return respond("MBTA data temporarily unavailable", status, { "Retry-After": String(retry) });
    };
    try {
      const cached = await run("cache_lookup", () => cache.match(key));
      if (cached) {
        fetchedAt = Number(cached.headers.get("X-Data-Fetched-At"));
        const age = (now() - fetchedAt) / 1000;
        if (Number.isFinite(fetchedAt) && age >= 0 && age < config.ttl + config.stale) {
          cachedBody = await run("cache_body", () => cached.text());
          if ((now() - fetchedAt) / 1000 < config.ttl) return serve(cachedBody, fetchedAt, "HIT");
        }
      }
      if (cooldownUntil > now()) return fail(503, Math.ceil((cooldownUntil - now()) / 1000));
      const cooldown = await run("cooldown_lookup", () => cache.match(cooldownKey));
      if (cooldown) {
        const until = Number(await run("cooldown_body", () => cooldown.text()));
        // Reject corrupt/future cache entries beyond the supported one-hour bound.
        if (until > now() && until <= now() + 3600_000) {
          cooldownUntil = Math.max(cooldownUntil, until);
          return fail(503, Math.ceil((until - now()) / 1000));
        }
      }
      const data = [], included = new Map(), seen = new Set();
      let next = upstream;
      while (next) {
        // Never send the secret to a pagination host supplied by the upstream response.
        if (next.origin !== UPSTREAM || next.pathname !== upstream.pathname || seen.has(next.href) || seen.size >= 10) {
          throw new Error("Invalid pagination");
        }
        seen.add(next.href);
        const response = await run("upstream_headers", () => fetchImpl(next.href, {
          headers: { Accept: JSON_API, "x-api-key": env.MBTA_API_KEY },
          redirect: "manual", signal: controller.signal
        }));
        diagnostic("upstream_headers", { page: seen.size, status: response.status });
        let retry = 0;
        if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0") {
          retry = retrySeconds(response, now());
          cooldownUntil = Math.max(cooldownUntil, now() + retry * 1000);
          write(cooldownKey, new Response(String(cooldownUntil), {
            headers: { "Cache-Control": `max-age=${retry}` }
          }), "cooldown");
          if (!response.ok) return fail(503, retry);
        }
        if (!response.ok) throw new Error("Upstream failed");
        const doc = await run("upstream_body", () => response.json());
        if (!Array.isArray(doc.data) || (doc.included !== undefined && !Array.isArray(doc.included))) throw new Error("Invalid document");
        data.push(...doc.data);
        for (const resource of doc.included || []) included.set(`${resource.type}:${resource.id}`, resource);
        const link = doc.links?.next;
        next = typeof link === "string" && link ? new URL(link, next) : null;
        diagnostic("upstream_page_complete", { page: seen.size, hasNext: !!next });
        if (next && retry) return fail(503, retry);
      }
      controller.signal.throwIfAborted();
      const fetched = now();
      const body = JSON.stringify({ data, included: [...included.values()], links: { next: null } });
      write(key, new Response(body, {
        headers: { "Content-Type": JSON_API, "X-Data-Fetched-At": String(fetched),
          "Cache-Control": `max-age=${config.ttl + config.stale}` }
      }), "snapshot");
      diagnostic("refresh_complete", { pages: seen.size });
      return serve(body, fetched, "MISS");
    } catch {
      diagnostic(controller.signal.aborted ? "operation_aborted" : "operation_failed");
      return fail(controller.signal.aborted ? 503 : 502, controller.signal.aborted ? 5 : 60);
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", cancel);
    }
  };
}

const handle = createProxy();
export default {
  fetch(request, env, ctx) {
    return handle(request, env, caches.default, ctx);
  }
};
