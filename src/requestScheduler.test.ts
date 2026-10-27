import { afterEach, describe, expect, it, vi } from "vitest";
import { createMbtaFetch } from "./requestScheduler";

afterEach(() => vi.useRealTimers());

describe("MBTA request scheduling", () => {
  it("starts a shape request while a vehicle poll is still in flight", async () => {
    vi.useFakeTimers();
    let finishPoll!: (response: Response) => void;
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finishPoll = resolve; }))
      .mockResolvedValue(new Response("shape"));
    const request = createMbtaFetch(fetchImpl);
    const poll = request("https://example.test/vehicles");
    await vi.advanceTimersByTimeAsync(0);
    const shape = await request.interactive("https://example.test/trips");
    expect(await shape.text()).toBe("shape");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    finishPoll(new Response("vehicles"));
    await poll;
  });

  it("serializes shape requests without the polling gap", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const request = createMbtaFetch(fetchImpl);
    const start = Date.now();
    await request("https://example.test/vehicles");
    await Promise.all([
      request.interactive("https://example.test/trips?filter[id]=1"),
      request.interactive("https://example.test/trips?filter[id]=2")
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(Date.now()).toBe(start);
  });

  it.each(["background", "interactive"] as const)("shares a %s cooldown with both queues", async (source) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "90" } }))
      .mockImplementation(async () => new Response("{}"));
    const request = createMbtaFetch(fetchImpl);
    await (source === "background" ? request : request.interactive)("https://example.test/trips");
    const poll = request("https://example.test/vehicles");
    const shape = request.interactive("https://example.test/trips");
    await vi.advanceTimersByTimeAsync(90_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([poll, shape]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rechecks cooldown when a poll is already waiting for its spacing", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("{}"))
      .mockResolvedValueOnce(new Response("{}", { status: 503, headers: { "retry-after": "90" } }))
      .mockResolvedValue(new Response("{}"));
    const request = createMbtaFetch(fetchImpl);
    await request("https://example.test/vehicles");
    const poll = request("https://example.test/vehicles");
    await vi.advanceTimersByTimeAsync(1000);
    await request.interactive("https://example.test/trips");
    await vi.advanceTimersByTimeAsync(90_999);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await poll;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

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
    [{ "retry-after": "120" }, 121_000, 503],
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

describe("request deadlines", () => {
  it("times out a stalled shape body and releases the interactive queue", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream({ start() {} })))
      .mockResolvedValue(new Response("{}"));
    const request = createMbtaFetch(fetchImpl, 100);
    const first = expect(request.interactive("https://example.test/trips")).rejects.toThrow("timed out");
    const second = request.interactive("https://example.test/trips");
    await vi.advanceTimersByTimeAsync(100);
    await first;
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    expect((await second).ok).toBe(true);
  });

  it.each(["headers", "body"])("releases the queue after stalled %s, even when abort is ignored", async stage => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockImplementationOnce(() => stage === "headers"
      ? new Promise(() => {}) : Promise.resolve(new Response(new ReadableStream({ start() {} }))))
      .mockResolvedValue(new Response('{"data":[]}'));
    const request = createMbtaFetch(fetchImpl, 100);
    const first = expect(request("https://example.test/vehicles")).rejects.toThrow("timed out");
    const second = request("https://example.test/vehicles");
    await vi.advanceTimersByTimeAsync(100);
    await first;
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(3400);
    expect(await (await second).json()).toEqual({ data: [] });
  });

  it("retains cooldown headers even if reading the rate-limit body stalls", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({ start() {} }), {
      status: 429, headers: { "Retry-After": "90" }
    })).mockResolvedValue(new Response("{}"));
    const request = createMbtaFetch(fetchImpl, 100);
    const first = expect(request("https://example.test/vehicles")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await first;
    const next = request("https://example.test/vehicles");
    await vi.advanceTimersByTimeAsync(90_899);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("preserves caller cancellation and allows subsequent requests", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValue(new Response("{}"));
    const request = createMbtaFetch(fetchImpl);
    const first = expect(request("https://example.test/vehicles", { signal: controller.signal })).rejects.toThrow("canceled");
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error("canceled"));
    await first;
    const second = request("https://example.test/vehicles");
    await vi.advanceTimersByTimeAsync(3500);
    expect((await second).ok).toBe(true);
  });
});
