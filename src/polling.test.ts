import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPollingLoop } from "./polling";

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
