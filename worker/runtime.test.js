// These checks execute the production proxy in workerd, with real Cache API and ctx.waitUntil.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

let mf;
beforeAll(async () => {
  const sourcePath = fileURLToPath(new URL("./index.js", import.meta.url));
  mf = new Miniflare(convertV4MiniflareOptions({
    compatibilityDate: "2026-10-26",
    modules: [
      { type: "ESModule", path: fileURLToPath(new URL("./runtime-entry.js", import.meta.url)), contents: `
        import { createProxy } from "./index.js";
        const handles = new Map(), counts = new Map();
        export default { async fetch(request, env, ctx) {
          const mode = request.headers.get("x-test-mode") || "normal";
          if (new URL(request.url).pathname === "/started") return Response.json(counts.get(mode) || 0);
          if (!handles.has(mode)) {
            let count = 0;
            handles.set(mode, createProxy({ budgetMs: 500, writeBudgetMs: 100, log() {},
              fetchImpl: async (url, init) => {
                const id = ++count; counts.set(mode, id);
                if ((mode === "headers" || mode === "cancel") && id === 1) {
                  await new Promise(resolve => setTimeout(resolve, 1250));
                  init.signal.throwIfAborted();
                }
                if (mode === "body" && id === 1) return new Response(new ReadableStream({ start() {} }));
                return Response.json({ data: [{ id: String(id) }] });
              }
            }));
          }
          const real = caches.default;
          const cache = {
            match: key => mode === "cache" ? new Promise(() => {}) : real.match(key),
            put: (key, response) => mode === "write-fail" ? Promise.reject(new Error("write failed")) :
              mode === "write-stall" ? new Promise(() => {}) : real.put(key, response)
          };
          // Separate canonical cache keys per test, while preserving the real request signal.
          const url = new URL(request.url); url.hostname = mode + ".test";
          return handles.get(mode)(new Request(url, request), { MBTA_API_KEY: "runtime-test-secret" }, cache, ctx);
        } }
      ` },
      { type: "ESModule", path: sourcePath, contents: await readFile(sourcePath, "utf8") }
    ],
    scriptPath: fileURLToPath(new URL("./runtime-entry.js", import.meta.url))
  }));
  await mf.ready;
}, 20_000);
afterAll(async () => { await mf?.dispose(); });
const request = (mode, options = {}) => mf.dispatchFetch("https://proxy.test/vehicles", {
  ...options, headers: { Origin: "https://paulhandorff.com", "x-test-mode": mode }
});

describe("Workers runtime lifecycle", () => {
  it("uses real cache writes through waitUntil, then serves a canonical cache hit", async () => {
    const response = await request("normal");
    expect(response.headers.get("X-Proxy-Cache")).toBe("MISS");
    expect((await response.json()).data).toHaveLength(1);
    // Cache writes run after returning the response. Poll for their observable completion.
    let hit;
    for (let attempt = 0; attempt < 20; attempt++) {
      hit = await request("normal");
      if (hit.headers.get("X-Proxy-Cache") === "HIT") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(hit.headers.get("X-Proxy-Cache")).toBe("HIT");
  });

  it.each(["headers", "body"])("bounds stalled %s and permits an independent concurrent request", async mode => {
    const first = request(mode);
    const second = request(mode);
    const responses = await Promise.all([first, second]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 503]);
    for (const response of responses) expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://paulhandorff.com");
    expect((await request(mode)).status).toBe(200);
  });

  it("bounds stalled cache access", async () => {
    expect((await request("cache")).status).toBe(503);
  });

  it.each(["write-fail", "write-stall"])("returns successful bodies independently of %s", async mode => {
    const response = await request(mode);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toHaveLength(1);
    expect((await request(mode)).status).toBe(200);
  });

  it("survives a disconnected client and serves later requests in the same isolate", async () => {
    const url = await mf.ready;
    const controller = new AbortController();
    const canceled = fetch(new URL("/vehicles", url), {
      headers: { "x-test-mode": "cancel" }, signal: controller.signal
    }).catch(error => error);
    // Observe entry into the slow upstream operation before disconnecting the client.
    let started = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const status = await mf.dispatchFetch("https://proxy.test/started", { headers: { "x-test-mode": "cancel" } });
      if (await status.json() === 1) { started = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(started).toBe(true);
    controller.abort();
    expect(await canceled).toBeInstanceOf(Error);
    const response = await request("cancel");
    expect(response.status).toBe(200);
    expect((await response.json()).data[0].id).toBe("2");
  });
});
