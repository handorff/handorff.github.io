import { afterEach, describe, expect, it, vi } from "vitest";
import { createShapePrefetcher } from "./shapePrefetch";
import { createTooltipMetadataStore } from "./tooltipMetadata";
import type { TripMetadata, Vehicle } from "./types";

const vehicle = (id: string): Vehicle => ({
  id, relatedTripId: id, routeId: "77", latitude: 42.36, longitude: -71.08,
  destination: null, currentStatus: null, relatedStopId: null
});

afterEach(() => vi.useRealTimers());

describe("shape prefetch", () => {
  it("ignores tiles passed over briefly and cancels when the pointer leaves", async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockResolvedValue(undefined);
    const prefetch = createShapePrefetcher(load, vi.fn());
    prefetch.target(vehicle("a"));
    await vi.advanceTimersByTimeAsync(100);
    prefetch.target(vehicle("b"));
    await vi.advanceTimersByTimeAsync(100);
    prefetch.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).not.toHaveBeenCalled();
  });

  it("shares a hover request with selection and retains the shape across snapshot updates", async () => {
    vi.useFakeTimers();
    let resolve!: (value: Map<string, TripMetadata>) => void;
    const fetchTripsByIds = vi.fn(() => new Promise<Map<string, TripMetadata>>((done) => { resolve = done; }));
    const changed = vi.fn();
    const store = createTooltipMetadataStore({ fetchTripsByIds, fetchStopsByIds: vi.fn(), onDataChanged: changed });
    const prefetch = createShapePrefetcher(store.ensureShapeLoaded, vi.fn());
    const hovered = vehicle("a");
    prefetch.target(hovered);
    await vi.advanceTimersByTimeAsync(60);
    prefetch.target({ ...hovered });
    await vi.advanceTimersByTimeAsync(60);
    expect(fetchTripsByIds).toHaveBeenCalledExactlyOnceWith(["a"]);
    prefetch.cancel();
    const selection = store.ensureShapeLoaded(hovered);
    resolve(new Map([["a", { destination: "Harvard", shapePolyline: "encoded" }]]));
    await selection;
    store.seed(new Map(), new Map([["a", { destination: "Harvard", shapePolyline: null }]]));
    await store.ensureShapeLoaded(hovered);
    expect(store.getShapePolyline(hovered)).toBe("encoded");
    expect(fetchTripsByIds).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith("a");
  });

  it("keeps only the latest target while another speculative request is in flight", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }))
      .mockResolvedValue(undefined);
    const prefetch = createShapePrefetcher(load, vi.fn());
    prefetch.target(vehicle("a"));
    await vi.advanceTimersByTimeAsync(120);
    prefetch.target(vehicle("b"));
    await vi.advanceTimersByTimeAsync(200);
    prefetch.target(vehicle("c"));
    await vi.advanceTimersByTimeAsync(200);
    expect(load).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(120);
    expect(load.mock.calls.map(([v]) => v.id)).toEqual(["a", "c"]);
  });

  it("does not start a new speculative request after cancellation or loop on failure", async () => {
    vi.useFakeTimers();
    let fail!: (error: Error) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise<void>((_, reject) => { fail = reject; }))
      .mockRejectedValue(new Error("offline"));
    const error = vi.fn();
    const prefetch = createShapePrefetcher(load, error);
    prefetch.target(vehicle("a"));
    await vi.advanceTimersByTimeAsync(120);
    prefetch.target(vehicle("b"));
    prefetch.cancel();
    fail(new Error("offline"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(1);
    prefetch.target(vehicle("c"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(2);
  });
});
