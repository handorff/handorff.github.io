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

export function createProxy({ fetchImpl = fetch, now = Date.now } = {}) {
  // Coalesce simultaneous requests handled by this isolate. Cache storage is per data center.
  const pending = new Map();
  return async function handle(request, env, cache) {
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
    const cached = await cache.match(key);
    const fetchedAt = cached ? Number(cached.headers.get("X-Data-Fetched-At")) : 0;
    const age = (now() - fetchedAt) / 1000;
    const serve = async (response, state) => respond(await response.text(), 200, {
      "Content-Type": JSON_API, "X-Data-Fetched-At": response.headers.get("X-Data-Fetched-At"),
      "X-Proxy-Cache": state
    });
    if (cached && age < config.ttl) return serve(cached, "HIT");
    const fail = async (status, retry = 60) => {
      if (cached && age < config.ttl + config.stale) return serve(cached, "STALE");
      return respond("MBTA data temporarily unavailable", status, { "Retry-After": String(retry) });
    };
    const cooldown = await cache.match(cooldownKey);
    if (cooldown) {
      const remaining = Math.ceil((Number(await cooldown.text()) - now()) / 1000);
      if (remaining > 0) return fail(503, remaining);
    }
    let refresh = pending.get(key.url);
    if (!refresh) {
      refresh = (async () => {
        const data = [], included = new Map(), seen = new Set();
        let next = upstream;
        while (next) {
          // Never send the secret to a pagination host supplied by the upstream response.
          if (next.origin !== UPSTREAM || next.pathname !== upstream.pathname || seen.has(next.href) || seen.size >= 10) {
            throw new Error("Invalid pagination");
          }
          seen.add(next.href);
          const response = await fetchImpl(next.href, {
            headers: { Accept: JSON_API, "x-api-key": env.MBTA_API_KEY },
            redirect: "manual", signal: AbortSignal.timeout(10000)
          });
          if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0") {
            const seconds = retrySeconds(response, now());
            await cache.put(cooldownKey, new Response(String(now() + seconds * 1000), {
              headers: { "Cache-Control": `max-age=${seconds}` }
            }));
            if (!response.ok) return { retry: seconds };
          }
          if (!response.ok) throw new Error("Upstream failed");
          const doc = await response.json();
          if (!Array.isArray(doc.data) || (doc.included !== undefined && !Array.isArray(doc.included))) throw new Error("Invalid document");
          data.push(...doc.data);
          for (const resource of doc.included || []) included.set(`${resource.type}:${resource.id}`, resource);
          const link = doc.links?.next;
          next = typeof link === "string" && link ? new URL(link, next) : null;
          if (next && response.headers.get("x-ratelimit-remaining") === "0") return { retry: 60 };
        }
        const fetched = now();
        const response = new Response(JSON.stringify({ data, included: [...included.values()], links: { next: null } }), {
          headers: { "Content-Type": JSON_API, "X-Data-Fetched-At": String(fetched),
            "Cache-Control": `max-age=${config.ttl + config.stale}` }
        });
        await cache.put(key, response.clone());
        return { response };
      })();
      pending.set(key.url, refresh);
      // Handle rejection here as well as in each caller to avoid unhandled promises.
      void refresh.finally(() => pending.delete(key.url)).catch(() => {});
    }
    try {
      const result = await refresh;
      return result.response ? serve(result.response.clone(), "MISS") : fail(503, result.retry);
    } catch { return fail(502); }
  };
}

const handle = createProxy();
export default {
  async fetch(request, env) {
    try { return await handle(request, env, caches.default); }
    catch { return new Response("Backend temporarily unavailable", { status: 503, headers: { "Cache-Control": "no-store" } }); }
  }
};
