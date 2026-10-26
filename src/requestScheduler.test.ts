import { afterEach, describe, expect, it, vi } from "vitest";
import { createMbtaFetch } from "./requestScheduler";

afterEach(() => vi.useRealTimers());

describe("MBTA request scheduling", () => {
  it("paces concurrent requests through one queue", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const request = createMbtaFetch(fetchImpl);
    const first = request("https://example.test/vehicles");
    const second = request("https://example.test/trips");
    await first;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3499);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ "retry-after": "90" }, 91_000, 429],
    [{ "retry-after": "Mon, 26 Oct 2026 12:01:30 GMT" }, 91_000, 429],
    [{ "x-ratelimit-reset": String(Date.parse("2026-10-26T12:01:30Z") / 1000) }, 91_000, 429],
    [{}, 60_000, 429],
    [{ "x-ratelimit-reset": "1" }, 60_000, 429],
    [{ "x-ratelimit-remaining": "0" }, 60_000, 200]
  ])("holds all subsequent requests during cooldown (%j)", async (headers, delay, status) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status, headers: headers as HeadersInit }))
      .mockResolvedValue(new Response("{}"));
    const request = createMbtaFetch(fetchImpl);
    await request("https://example.test/vehicles");
    const next = request("https://example.test/trips");
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("continues after a network failure", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(new Response("{}"));
    const request = createMbtaFetch(fetchImpl);
    await expect(request("https://example.test/vehicles")).rejects.toThrow("offline");
    const next = request("https://example.test/vehicles");
    await vi.advanceTimersByTimeAsync(3500);
    await expect(next).resolves.toBeInstanceOf(Response);
  });
});
