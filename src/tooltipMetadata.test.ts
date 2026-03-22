import { describe, expect, it, vi } from "vitest";
import type { TripMetadata, Vehicle } from "./types";
import {
  createTooltipMetadataStore,
  LOADING_DESTINATION_TEXT,
  LOADING_STOP_TEXT,
  UNKNOWN_DESTINATION_TEXT,
  UNKNOWN_STOP_TEXT
} from "./tooltipMetadata";

function makeVehicle(overrides: Partial<Vehicle> = {}): Vehicle {
  return {
    id: "vehicle-1",
    routeId: "77",
    latitude: 42.36,
    longitude: -71.08,
    destination: null,
    currentStatus: "IN_TRANSIT_TO",
    relatedStopId: null,
    relatedTripId: null,
    ...overrides
  };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tripMetadata(destination: string | null, shapePolyline: string | null = null): TripMetadata {
  return {
    destination,
    shapePolyline
  };
}

describe("tooltip metadata store", () => {
  it("filters out vehicles with missing trip ids", () => {
    const store = createTooltipMetadataStore({
      fetchStopsByIds: vi.fn().mockResolvedValue(new Map<string, string>()),
      fetchTripsByIds: vi.fn().mockResolvedValue(new Map<string, TripMetadata>())
    });

    expect(
      store.filterRenderableVehicles([
        makeVehicle({ id: "v1", relatedTripId: null }),
        makeVehicle({ id: "v2", relatedTripId: "   " })
      ])
    ).toEqual([]);
  });

  it("filters out vehicles with uncached trip ids until validation completes", async () => {
    const deferredTrips = createDeferred<Map<string, TripMetadata>>();
    const store = createTooltipMetadataStore({
      fetchStopsByIds: vi.fn().mockResolvedValue(new Map<string, string>()),
      fetchTripsByIds: vi.fn().mockReturnValue(deferredTrips.promise)
    });

    const vehicle = makeVehicle({ relatedTripId: "trip-1" });
    const pendingEnsure = store.ensureTripsLoaded([vehicle]);

    expect(store.filterRenderableVehicles([vehicle])).toEqual([]);

    deferredTrips.resolve(new Map([["trip-1", tripMetadata("Harvard")]]));
    await pendingEnsure;
  });

  it("includes vehicles after their trips are validated", async () => {
    const store = createTooltipMetadataStore({
      fetchStopsByIds: vi.fn().mockResolvedValue(new Map<string, string>()),
      fetchTripsByIds: vi
        .fn()
        .mockResolvedValue(new Map([["trip-1", tripMetadata("Harvard")]]))
    });

    const vehicle = makeVehicle({ relatedTripId: "trip-1" });

    await store.ensureTripsLoaded([vehicle]);

    expect(store.filterRenderableVehicles([vehicle])).toEqual([vehicle]);
  });

  it("keeps vehicles excluded when their requested trips do not exist", async () => {
    const store = createTooltipMetadataStore({
      fetchStopsByIds: vi.fn().mockResolvedValue(new Map<string, string>()),
      fetchTripsByIds: vi.fn().mockResolvedValue(new Map<string, TripMetadata>())
    });

    const vehicle = makeVehicle({ relatedTripId: "trip-missing" });

    await store.ensureTripsLoaded([vehicle]);

    expect(store.filterRenderableVehicles([vehicle])).toEqual([]);
  });

  it("dedupes in-flight trip validation requests", async () => {
    const deferredTrips = createDeferred<Map<string, TripMetadata>>();
    const fetchTripsByIds = vi.fn().mockReturnValue(deferredTrips.promise);
    const store = createTooltipMetadataStore({
      fetchStopsByIds: vi.fn().mockResolvedValue(new Map<string, string>()),
      fetchTripsByIds
    });

    const vehicle = makeVehicle({ relatedTripId: "trip-1" });

    const firstEnsure = store.ensureTripsLoaded([vehicle]);
    const secondEnsure = store.ensureTripsLoaded([vehicle]);

    expect(fetchTripsByIds).toHaveBeenCalledTimes(1);
    expect(fetchTripsByIds).toHaveBeenCalledWith(["trip-1"]);

    deferredTrips.resolve(new Map([["trip-1", tripMetadata("Harvard")]]));
    await firstEnsure;
    await secondEnsure;
  });

  it("clears pending trip validation on failure so a later request can retry", async () => {
    const fetchTripsByIds = vi
      .fn()
      .mockRejectedValueOnce(new Error("rate limit"))
      .mockResolvedValueOnce(new Map([["trip-1", tripMetadata("Harvard")]]));
    const store = createTooltipMetadataStore({
      fetchStopsByIds: vi.fn().mockResolvedValue(new Map<string, string>()),
      fetchTripsByIds
    });

    const vehicle = makeVehicle({ relatedTripId: "trip-1" });

    await expect(store.ensureTripsLoaded([vehicle])).rejects.toThrow("rate limit");

    await store.ensureTripsLoaded([vehicle]);
    expect(fetchTripsByIds).toHaveBeenCalledTimes(2);
    expect(store.filterRenderableVehicles([vehicle])).toEqual([vehicle]);
  });

  it("does not prefetch while content is visible", async () => {
    const fetchStopsByIds = vi.fn().mockResolvedValue(new Map<string, string>());
    const fetchTripsByIds = vi.fn().mockResolvedValue(new Map<string, TripMetadata>());
    const store = createTooltipMetadataStore({
      fetchStopsByIds,
      fetchTripsByIds
    });

    await store.prefetchFromVehicles([
      makeVehicle({ relatedStopId: "place-cntsq", relatedTripId: "trip-1" })
    ]);

    expect(fetchStopsByIds).not.toHaveBeenCalled();
    expect(fetchTripsByIds).not.toHaveBeenCalled();
  });

  it("prefetches stops and trips in a single request each when hidden", async () => {
    const fetchStopsByIds = vi
      .fn()
      .mockResolvedValue(new Map([["place-cntsq", "Central Square"]]));
    const fetchTripsByIds = vi
      .fn()
      .mockResolvedValue(new Map([["trip-1", tripMetadata("Harvard")]]));
    const store = createTooltipMetadataStore({
      fetchStopsByIds,
      fetchTripsByIds
    });

    store.setHiddenModeEnabled(true);
    await store.prefetchFromVehicles([
      makeVehicle({ id: "v1", relatedStopId: "place-cntsq", relatedTripId: "trip-1" }),
      makeVehicle({ id: "v2", relatedStopId: "place-cntsq", relatedTripId: "trip-1" }),
      makeVehicle({ id: "v3", relatedStopId: "place-pktrm", relatedTripId: "trip-2" })
    ]);

    expect(fetchStopsByIds).toHaveBeenCalledTimes(1);
    expect(fetchTripsByIds).toHaveBeenCalledTimes(1);
    expect(fetchStopsByIds).toHaveBeenCalledWith(["place-cntsq", "place-pktrm"]);
    expect(fetchTripsByIds).toHaveBeenCalledWith(["trip-1", "trip-2"]);
  });

  it("dedupes pending IDs across rapid repeated prefetch calls", async () => {
    const deferredStops = createDeferred<Map<string, string>>();
    const deferredTrips = createDeferred<Map<string, TripMetadata>>();
    const fetchStopsByIds = vi.fn().mockReturnValue(deferredStops.promise);
    const fetchTripsByIds = vi.fn().mockReturnValue(deferredTrips.promise);
    const store = createTooltipMetadataStore({
      fetchStopsByIds,
      fetchTripsByIds
    });

    const vehicles = [
      makeVehicle({ id: "v1", relatedStopId: "place-cntsq", relatedTripId: "trip-1" })
    ];

    store.setHiddenModeEnabled(true);
    const firstPrefetch = store.prefetchFromVehicles(vehicles);
    const secondPrefetch = store.prefetchFromVehicles(vehicles);

    expect(fetchStopsByIds).toHaveBeenCalledTimes(1);
    expect(fetchTripsByIds).toHaveBeenCalledTimes(1);

    deferredStops.resolve(new Map([["place-cntsq", "Central Square"]]));
    deferredTrips.resolve(new Map([["trip-1", tripMetadata("Harvard")]]));
    await firstPrefetch;
    await secondPrefetch;
  });

  it("marks requested but missing IDs as unknown after fetch completes", async () => {
    const fetchStopsByIds = vi
      .fn()
      .mockResolvedValue(new Map([["place-cntsq", "Central Square"]]));
    const fetchTripsByIds = vi
      .fn()
      .mockResolvedValue(new Map([["trip-1", tripMetadata("Harvard")]]));
    const store = createTooltipMetadataStore({
      fetchStopsByIds,
      fetchTripsByIds
    });

    const missingVehicle = makeVehicle({
      relatedStopId: "place-missing",
      relatedTripId: "trip-missing"
    });

    store.setHiddenModeEnabled(true);
    await store.prefetchFromVehicles([missingVehicle]);

    expect(store.getStopText(missingVehicle)).toBe(UNKNOWN_STOP_TEXT);
    expect(store.getDestinationText(missingVehicle)).toBe(UNKNOWN_DESTINATION_TEXT);
    expect(store.getShapePolyline(missingVehicle)).toBeNull();
  });

  it("shows loading text while metadata request is pending, then updates", async () => {
    const deferredStops = createDeferred<Map<string, string>>();
    const deferredTrips = createDeferred<Map<string, TripMetadata>>();
    const fetchStopsByIds = vi.fn().mockReturnValue(deferredStops.promise);
    const fetchTripsByIds = vi.fn().mockReturnValue(deferredTrips.promise);
    const onDataChanged = vi.fn();
    const store = createTooltipMetadataStore({
      fetchStopsByIds,
      fetchTripsByIds,
      onDataChanged
    });

    const vehicle = makeVehicle({
      relatedStopId: "place-cntsq",
      relatedTripId: "trip-1"
    });

    store.setHiddenModeEnabled(true);
    const pendingPrefetch = store.prefetchFromVehicles([vehicle]);

    expect(store.getStopText(vehicle)).toBe(LOADING_STOP_TEXT);
    expect(store.getDestinationText(vehicle)).toBe(LOADING_DESTINATION_TEXT);
    expect(store.getShapePolyline(vehicle)).toBeNull();

    deferredStops.resolve(new Map([["place-cntsq", "Central Square"]]));
    deferredTrips.resolve(new Map([["trip-1", tripMetadata("Harvard", "encoded-polyline")]]));
    await pendingPrefetch;

    expect(store.getStopText(vehicle)).toBe("Central Square");
    expect(store.getDestinationText(vehicle)).toBe("Harvard");
    expect(store.getShapePolyline(vehicle)).toBe("encoded-polyline");
    expect(onDataChanged).toHaveBeenCalledTimes(1);
  });

  it("clears pending on failure so the next hidden prefetch can retry", async () => {
    const fetchStopsByIds = vi
      .fn()
      .mockRejectedValueOnce(new Error("rate limit"))
      .mockResolvedValueOnce(new Map([["place-cntsq", "Central Square"]]));
    const fetchTripsByIds = vi.fn().mockResolvedValue(new Map<string, TripMetadata>());
    const store = createTooltipMetadataStore({
      fetchStopsByIds,
      fetchTripsByIds
    });

    const vehicle = makeVehicle({ relatedStopId: "place-cntsq" });

    store.setHiddenModeEnabled(true);
    await expect(store.prefetchFromVehicles([vehicle])).rejects.toThrow("rate limit");

    await store.prefetchFromVehicles([vehicle]);
    expect(fetchStopsByIds).toHaveBeenCalledTimes(2);
  });

  it("ignores in-flight response writes if hidden mode is turned off before completion", async () => {
    const deferredStops = createDeferred<Map<string, string>>();
    const fetchStopsByIds = vi.fn().mockReturnValue(deferredStops.promise);
    const fetchTripsByIds = vi.fn().mockResolvedValue(new Map<string, TripMetadata>());
    const store = createTooltipMetadataStore({
      fetchStopsByIds,
      fetchTripsByIds
    });

    const vehicle = makeVehicle({ relatedStopId: "place-cntsq" });

    store.setHiddenModeEnabled(true);
    const prefetch = store.prefetchFromVehicles([vehicle]);
    store.setHiddenModeEnabled(false);

    deferredStops.resolve(new Map([["place-cntsq", "Central Square"]]));
    await prefetch;

    store.setHiddenModeEnabled(true);
    expect(store.getStopText(vehicle)).toBe(LOADING_STOP_TEXT);
  });
});
