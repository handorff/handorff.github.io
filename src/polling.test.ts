import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindPageLifecycle, createPollingLoop } from "./polling";

describe("createPollingLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs immediately on start and then on each interval", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const loop = createPollingLoop({
      intervalMs: 1_000,
      task
    });

    loop.start();
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);
    expect(task).toHaveBeenCalledTimes(4);
  });

  it("prevents overlapping runs while a task is in flight", async () => {
    let releaseFirstTask!: () => void;
    const firstTask = new Promise<void>((resolve) => {
      releaseFirstTask = () => resolve();
    });

    const task = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstTask)
      .mockResolvedValue(undefined);

    const loop = createPollingLoop({
      intervalMs: 1_000,
      task
    });

    loop.start();
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
    expect(loop.isInFlight()).toBe(true);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(task).toHaveBeenCalledTimes(1);

    releaseFirstTask();
    await Promise.resolve();
    expect(loop.isInFlight()).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("pauses while hidden and resumes with an immediate run", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const loop = createPollingLoop({
      intervalMs: 1_000,
      task
    });

    loop.start();
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);

    loop.setPaused(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(task).toHaveBeenCalledTimes(1);

    loop.setPaused(false);
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("does not trigger an extra run when unpausing is a no-op", async () => {
    const task = vi.fn().mockResolvedValue(undefined);
    const loop = createPollingLoop({
      intervalMs: 1_000,
      task
    });

    loop.start();
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);

    loop.setPaused(false);
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);
  });
});


describe("page lifecycle", () => {
  it("resumes stopped polling when Back restores a cached page", async () => {
    vi.useFakeTimers();
    try {
      const target = new EventTarget();
      const task = vi.fn().mockResolvedValue(undefined);
      const loop = createPollingLoop({ intervalMs: 1000, task });
      const stopRenderer = vi.fn();
      const startRenderer = vi.fn();
      bindPageLifecycle(target, () => {
        loop.stop();
        stopRenderer();
      }, () => {
        startRenderer();
        loop.start();
      });
      loop.start();
      await vi.advanceTimersByTimeAsync(0);
      target.dispatchEvent(new Event("pagehide"));
      await vi.advanceTimersByTimeAsync(3000);
      expect(task).toHaveBeenCalledTimes(1);
      expect(stopRenderer).toHaveBeenCalledTimes(1);
      // Ordinary initial pageshow must not start a second loop.
      target.dispatchEvent(new Event("pageshow"));
      expect(startRenderer).not.toHaveBeenCalled();
      const restored = new Event("pageshow");
      Object.defineProperty(restored, "persisted", { value: true });
      target.dispatchEvent(restored);
      await vi.advanceTimersByTimeAsync(0);
      expect(startRenderer).toHaveBeenCalledTimes(1);
      expect(task).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(task).toHaveBeenCalledTimes(3);
      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("polling request recovery", () => {
  it("keeps the last frame during a body timeout and automatically polls again", async () => {
    const { createMbtaFetch } = await import("./requestScheduler");
    vi.useFakeTimers();
    try {
      let frame = "last successful frame";
      const fetchImpl = vi.fn().mockResolvedValueOnce(new Response(new ReadableStream({ start() {} })))
        .mockResolvedValue(new Response("new frame"));
      const request = createMbtaFetch(fetchImpl, 100);
      const loop = createPollingLoop({ intervalMs: 10_000, task: async () => {
        try { frame = await (await request("https://example.test/vehicles")).text(); }
        catch { /* main.ts keeps the previous successful frame */ }
      } });
      loop.start();
      await vi.advanceTimersByTimeAsync(100);
      expect(loop.isInFlight()).toBe(false);
      expect(frame).toBe("last successful frame");
      await vi.advanceTimersByTimeAsync(9900);
      expect(frame).toBe("new frame");
      expect(loop.isInFlight()).toBe(false);
      loop.stop();
    } finally { vi.useRealTimers(); }
  });
});
