import { describe, expect, it, vi } from "vitest";
import { createProxy } from "./index.js";

const ORIGIN = "https://paulhandorff.com";
const SECRET = "test-secret-do-not-return";
function setup() {
  let time = 1800000000000;
  const entries = new Map();
  const cache = {
    match: async key => entries.get(key.url)?.clone(),
    put: async (key, response) => { entries.set(key.url, response.clone()); }
  };
  const fetchImpl = vi.fn(async () => Response.json({ data: [{ type: "vehicle", id: "v1" }] }));
  const handle = createProxy({ fetchImpl, now: () => time });
  const request = (path = "/vehicles", options = {}) => handle(new Request(`https://proxy.test${path}`, {
    headers: { Origin: ORIGIN }, ...options
  }), { MBTA_API_KEY: SECRET }, cache);
  return { request, fetchImpl, advance: seconds => { time += seconds * 1000; } };
}

describe("MBTA caching Worker", () => {
  it("shares the canonical cache, sends the secret only upstream, and applies CORS after caching", async () => {
    const { request, fetchImpl } = setup();
    const first = await request();
    expect(first.headers.get("X-Proxy-Cache")).toBe("MISS");
    expect(first.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(await first.text()).not.toContain(SECRET);
    const second = await request("/vehicles?page[limit]=1000", { headers: { Origin: "http://localhost:5173" } });
    expect(second.headers.get("X-Proxy-Cache")).toBe("HIT");
    expect(second.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/^https:\/\/api-v3.mbta.com\/vehicles/);
    expect(url).not.toContain(SECRET);
    expect(init.headers["x-api-key"]).toBe(SECRET);
    expect(init.redirect).toBe("manual");
  });

  it("merges all upstream pages and deduplicates included resources", async () => {
    const { request, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(Response.json({ data: [{ id: "1" }], included: [{ type: "route", id: "Red" }], links: { next: "https://api-v3.mbta.com/vehicles?page[offset]=1000" } }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: "2" }], included: [{ type: "route", id: "Red" }] }));
    const result = await (await request()).json();
    expect(result.data).toHaveLength(2);
    expect(result.included).toHaveLength(1);
    expect(result.links.next).toBeNull();
  });

  it("never forwards the key to a different pagination host", async () => {
    const { request, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(Response.json({ data: [], links: { next: "https://evil.test/vehicles" } }));
    expect((await request()).status).toBe(502);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported methods, origins, IDs, and query parameters before fetching", async () => {
    const { request, fetchImpl } = setup();
    expect((await request("/vehicles", { method: "POST" })).status).toBe(405);
    expect((await request("/vehicles", { headers: { Origin: "https://evil.test" } })).status).toBe(403);
    expect((await request("/vehicles?url=https://evil.test")).status).toBe(400);
    expect((await request("/stops")).status).toBe(400);
    expect((await request("/trips?filter[id]=a&filter[id]=b")).status).toBe(400);
    expect((await request("/trips?filter[id]=a/b")).status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("canonicalizes trip IDs so equivalent requests share cached shapes", async () => {
    const { request, fetchImpl } = setup();
    await request("/trips?filter[id]=b,a,a");
    expect((await request("/trips?filter[id]=a,b")).headers.get("X-Proxy-Cache")).toBe("HIT");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get("include")).toBe("shape");
  });

  it("serves bounded stale data on a 429 and shares cooldown across endpoints", async () => {
    const { request, fetchImpl, advance } = setup();
    await request();
    advance(11);
    fetchImpl.mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "Retry-After": "120" } }));
    expect((await request()).headers.get("X-Proxy-Cache")).toBe("STALE");
    const other = await request("/stops?filter[id]=place-alfcl");
    expect(other.status).toBe(503);
    expect(other.headers.get("Retry-After")).toBe("120");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    advance(60);
    expect((await request()).status).toBe(503);
    advance(61);
    expect((await request()).headers.get("X-Proxy-Cache")).toBe("MISS");
  });

  it("keeps the last success on malformed or failed refreshes, then expires it", async () => {
    const { request, fetchImpl, advance } = setup();
    await request();
    advance(11);
    fetchImpl.mockResolvedValue(Response.json({ errors: [] }));
    expect((await request()).headers.get("X-Proxy-Cache")).toBe("STALE");
    advance(60);
    expect((await request()).status).toBe(502);
  });

  it("coalesces simultaneous cache misses in the same isolate", async () => {
    const { request, fetchImpl } = setup();
    const responses = await Promise.all([request(), request(), request()]);
    expect(responses.every(response => response.ok)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await responses[0].text()).toBe(await responses[1].text());
  });

  it("handles preflight without querying MBTA", async () => {
    const { request, fetchImpl } = setup();
    const response = await request("/vehicles", { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
