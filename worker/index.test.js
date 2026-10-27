import { afterEach, describe, expect, it, vi } from "vitest";
import { createProxy } from "./index.js";

const ORIGIN = "https://paulhandorff.com";
const SECRET = "test-secret-do-not-return";
function setup(options = {}) {
  let time = 1800000000000;
  const entries = new Map();
  const cache = {
    match: async key => entries.get(key.url)?.clone(),
    put: async (key, response) => { entries.set(key.url, response.clone()); }
  };
  const fetchImpl = vi.fn(async () => Response.json({ data: [{ type: "vehicle", id: "v1" }] }));
  const log = vi.fn();
  const handle = createProxy({ fetchImpl, now: () => time, log, ...options });
  const jobs = [];
  const ctx = { waitUntil: job => jobs.push(job) };
  const request = (path = "/vehicles", options = {}) => handle(new Request(`https://proxy.test${path}`, {
    headers: { Origin: ORIGIN }, ...options
  }), { MBTA_API_KEY: SECRET }, cache, ctx);
  return { request, fetchImpl, cache, log, jobs, advance: seconds => { time += seconds * 1000; } };
}

afterEach(() => vi.useRealTimers());

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

  it("isolates simultaneous cache misses without sharing request I/O", async () => {
    const { request, fetchImpl } = setup();
    const responses = await Promise.all([request(), request(), request()]);
    expect(responses.every(response => response.ok)).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(await responses[0].text()).toBe(await responses[1].text());
  });

  it.each(["cycle", "limit", "path", "redirect"])("rejects unsafe/incomplete pagination: %s", async mode => {
    const { request, fetchImpl } = setup();
    let page = 0;
    fetchImpl.mockImplementation(async url => {
      if (mode === "redirect") return new Response(null, { status: 302, headers: { Location: "https://evil.test" } });
      const next = mode === "cycle" ? url : mode === "path" ? "/routes" : `/vehicles?page[offset]=${++page}`;
      return Response.json({ data: [], links: { next } });
    });
    expect((await request()).status).toBe(502);
    expect(fetchImpl.mock.calls.length).toBe(mode === "limit" ? 10 : 1);
  });

  it("does not cache partial results when quota runs out during pagination", async () => {
    const { request, fetchImpl } = setup();
    fetchImpl.mockResolvedValueOnce(Response.json({ data: [{ id: "partial" }], links: { next: "/vehicles?page[offset]=1" } }, {
      headers: { "x-ratelimit-remaining": "0", "Retry-After": "90" }
    }));
    const response = await request();
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("90");
    expect(await response.text()).not.toContain("partial");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("handles preflight without querying MBTA", async () => {
    const { request, fetchImpl } = setup();
    const response = await request("/vehicles", { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, OPTIONS");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});


describe("Worker operation deadlines", () => {
  it.each(["headers", "body", "cache_lookup", "cache_body", "cooldown_lookup", "cooldown_body"])("bounds stalled %s and recovers", async stage => {
    vi.useFakeTimers();
    const { request, fetchImpl, cache, log } = setup({ budgetMs: 100 });
    const stall = () => new Promise(() => {});
    if (stage === "headers") fetchImpl.mockImplementationOnce(stall);
    if (stage === "body") fetchImpl.mockResolvedValueOnce(new Response(new ReadableStream({ start() {} })));
    if (stage === "cache_lookup") vi.spyOn(cache, "match").mockImplementationOnce(stall);
    if (stage === "cache_body") vi.spyOn(cache, "match").mockResolvedValueOnce({
      headers: new Headers({ "X-Data-Fetched-At": "1800000000000" }), text: stall
    });
    if (stage.startsWith("cooldown")) {
      const match = vi.spyOn(cache, "match").mockResolvedValueOnce(undefined);
      if (stage === "cooldown_lookup") match.mockImplementationOnce(stall);
      else match.mockResolvedValueOnce({ text: stall });
    }
    const first = request();
    await vi.advanceTimersByTimeAsync(100);
    const response = await first;
    expect(response.status).toBe(503);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "operation_aborted" }));
    expect((await request()).status).toBe(200);
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
  });

  it("shares one deadline across all pagination pages and aborts upstream work", async () => {
    vi.useFakeTimers();
    const { request, fetchImpl } = setup({ budgetMs: 100 });
    fetchImpl.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 70));
      return Response.json({ data: [], links: { next: "/vehicles?page[offset]=1" } });
    });
    const pending = request();
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns stale data on timeout, but measures its age at fallback time", async () => {
    vi.useFakeTimers();
    const { request, fetchImpl, advance } = setup({ budgetMs: 100 });
    await request();
    advance(11);
    fetchImpl.mockImplementation(() => new Promise(() => {}));
    const stale = request();
    await vi.advanceTimersByTimeAsync(100);
    expect((await stale).headers.get("X-Proxy-Cache")).toBe("STALE");
    advance(58);
    const expired = request();
    await vi.advanceTimersByTimeAsync(50);
    advance(2);
    await vi.advanceTimersByTimeAsync(50);
    expect((await expired).status).toBe(503);
  });

  it.each(["reject", "stall"])("successful data survives a cache-write %s", async mode => {
    vi.useFakeTimers();
    const { request, cache, jobs, log } = setup({ writeBudgetMs: 50 });
    vi.spyOn(cache, "put").mockImplementation(() => mode === "reject" ? Promise.reject(new Error(SECRET)) : new Promise(() => {}));
    const response = await request();
    expect(response.status).toBe(200);
    expect(jobs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all(jobs);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ event: "cache_write_failed", kind: "snapshot" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET);
  });

  it("honors local cooldown even if persistence fails", async () => {
    const { request, cache, fetchImpl } = setup();
    vi.spyOn(cache, "put").mockRejectedValue(new Error("cache unavailable"));
    fetchImpl.mockResolvedValueOnce(new Response("limited", { status: 429, headers: { "Retry-After": "120" } }));
    expect((await request()).status).toBe(503);
    expect((await request("/routes")).headers.get("Retry-After")).toBe("120");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("cancellation and a simultaneous stalled request cannot poison later requests", async () => {
    const { request, fetchImpl } = setup();
    fetchImpl.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const canceled = request("/vehicles", { signal: controller.signal });
    // Let the canceled request reach its upstream fetch first.
    while (fetchImpl.mock.calls.length === 0) await Promise.resolve();
    const other = await request();
    controller.abort();
    expect(other.status).toBe(200);
    expect((await canceled).status).toBe(503);
    expect((await request()).status).toBe(200);
  });
});
