import { describe, expect, it, vi } from "vitest";
import {
  fetchStopsByIds,
  fetchTripsByIds,
  fetchPaginated,
  fetchRoutes,
  fetchVehicles,
  fetchVehicleSnapshot,
  normalizeColorHex,
  normalizeSortOrder
} from "./mbtaApi";

type FetchMap = Record<string, unknown>;

function createFetchMock(payloads: FetchMap): (input: string | URL, init?: RequestInit) => Promise<Response> {
  return vi.fn(async (input) => {
    const url = String(input);
    const payload = payloads[url];
    if (!payload) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });
}

describe("normalization helpers", () => {
  it("normalizes valid hex colors and rejects invalid colors", () => {
    expect(normalizeColorHex("#ABCDEF")).toBe("#abcdef");
    expect(normalizeColorHex("336699")).toBe("#336699");
    expect(normalizeColorHex("zzzzzz")).toBeNull();
    expect(normalizeColorHex(null)).toBeNull();
  });

  it("normalizes sort order values and defaults missing values to Infinity", () => {
    expect(normalizeSortOrder(12)).toBe(12);
    expect(normalizeSortOrder("8")).toBe(8);
    expect(normalizeSortOrder(undefined)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("pagination", () => {
  it("collects data from multiple pages", async () => {
    const fetchMock = createFetchMock({
      "https://example.test/items?page=1": {
        data: [{ id: "a" }],
        links: { next: "/items?page=2" }
      },
      "https://example.test/items?page=2": {
        data: [{ id: "b" }]
      }
    });

    const results = await fetchPaginated("https://example.test/items?page=1", fetchMock);
    expect(results).toHaveLength(2);
    expect(results.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("throws if pagination enters a cycle", async () => {
    const fetchMock = createFetchMock({
      "https://example.test/items?page=1": {
        data: [{ id: "a" }],
        links: { next: "/items?page=2" }
      },
      "https://example.test/items?page=2": {
        data: [{ id: "b" }],
        links: { next: "/items?page=1" }
      }
    });

    await expect(
      fetchPaginated("https://example.test/items?page=1", fetchMock)
    ).rejects.toThrow("Detected pagination cycle");
  });
});

describe("MBTA resource parsing", () => {
  it("maps /vehicles payloads to vehicle models and drops invalid coordinates", async () => {
    const fetchMock = createFetchMock({
      "https://example.test/vehicles": {
        data: [
          {
            id: "v1",
            attributes: {
              latitude: 42.36,
              longitude: -71.08,
              destination: "Harvard",
              current_status: "IN_TRANSIT_TO"
            },
            relationships: {
              route: { data: { id: "Red" } },
              stop: { data: { id: "place-cntsq" } },
              trip: { data: { id: "trip-1" } }
            }
          },
          {
            id: "v2",
            attributes: { latitude: null, longitude: -71.09 },
            relationships: { route: { data: { id: "Green-B" } } }
          }
        ]
      }
    });

    const vehicles = await fetchVehicles("https://example.test", "/vehicles", fetchMock);
    expect(vehicles).toEqual([
      {
        id: "v1",
        routeId: "Red",
        latitude: 42.36,
        longitude: -71.08,
        destination: "Harvard",
        currentStatus: "IN_TRANSIT_TO",
        relatedStopId: "place-cntsq",
        relatedTripId: "trip-1"
      }
    ]);
  });

  it("maps unknown vehicle status to null", async () => {
    const fetchMock = createFetchMock({
      "https://example.test/vehicles": {
        data: [
          {
            id: "v1",
            attributes: {
              latitude: 42.36,
              longitude: -71.08,
              destination: "Forest Hills",
              current_status: "DELAYED"
            }
          }
        ]
      }
    });

    const vehicles = await fetchVehicles("https://example.test", "/vehicles", fetchMock);
    expect(vehicles).toEqual([
      {
        id: "v1",
        routeId: null,
        latitude: 42.36,
        longitude: -71.08,
        destination: "Forest Hills",
        currentStatus: null,
        relatedStopId: null,
        relatedTripId: null
      }
    ]);
  });

  it("maps /routes payloads to route metadata", async () => {
    const fetchMock = createFetchMock({
      "https://example.test/routes": {
        data: [
          {
            id: "Red",
            attributes: {
              color: "DA291C",
              sort_order: 10,
              short_name: "Red",
              long_name: "Red Line"
            }
          },
          {
            id: "Mystery",
            attributes: {
              color: "invalid",
              sort_order: null,
              short_name: "",
              long_name: "Mystery Long Name"
            }
          }
        ]
      }
    });

    const routes = await fetchRoutes("https://example.test", "/routes", fetchMock);
    expect(routes).toEqual([
      {
        id: "Red",
        colorHex: "#da291c",
        sortOrder: 10,
        shortName: "Red",
        longName: "Red Line"
      },
      {
        id: "Mystery",
        colorHex: null,
        sortOrder: Number.POSITIVE_INFINITY,
        shortName: null,
        longName: "Mystery Long Name"
      }
    ]);
  });

  it("maps stop ids to stop names and skips blank names", async () => {
    const fetchMock = createFetchMock({
      "https://example.test/stops?filter%5Bid%5D=place-alfcl%2Cplace-cntsq&fields%5Bstop%5D=name&page%5Blimit%5D=1000":
        {
          data: [
            {
              id: "place-alfcl",
              attributes: { name: "Alewife" }
            },
            {
              id: "place-cntsq",
              attributes: { name: "   " }
            }
          ]
        }
    });

    const stops = await fetchStopsByIds(
      ["place-alfcl", "place-cntsq"],
      "https://example.test",
      "/stops",
      fetchMock
    );

    expect(stops).toEqual(new Map([["place-alfcl", "Alewife"]]));
  });

  it("returns an empty map and does not fetch for empty stop ids", async () => {
    const fetchMock = vi.fn();
    const result = await fetchStopsByIds([], "https://example.test", "/stops", fetchMock);

    expect(result).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps trip ids to destination names and skips blank headsigns", async () => {
    const fetchMock = createFetchMock({
      "https://example.test/trips?filter%5Bid%5D=trip-1%2Ctrip-2&include=shape&fields%5Btrip%5D=headsign%2Cshape&fields%5Bshape%5D=polyline&page%5Blimit%5D=1000":
        {
          data: [
            {
              id: "trip-1",
              attributes: { headsign: "Harvard" },
              relationships: {
                shape: { data: { id: "shape-1" } }
              }
            },
            {
              id: "trip-2",
              attributes: { headsign: "  " },
              relationships: {
                shape: { data: { id: "shape-2" } }
              }
            }
          ],
          included: [
            {
              id: "shape-1",
              type: "shape",
              attributes: { polyline: "encoded-1" }
            },
            {
              id: "shape-2",
              type: "shape",
              attributes: { polyline: "encoded-2" }
            }
          ]
        }
    });

    const metadataByTripId = await fetchTripsByIds(
      ["trip-1", "trip-2"],
      "https://example.test",
      "/trips",
      fetchMock
    );

    expect(metadataByTripId).toEqual(
      new Map([
        [
          "trip-1",
          {
            destination: "Harvard",
            shapePolyline: "encoded-1"
          }
        ],
        [
          "trip-2",
          {
            destination: null,
            shapePolyline: "encoded-2"
          }
        ]
      ])
    );
  });

  it("sets shapePolyline to null when relationship or included polyline is missing", async () => {
    const fetchMock = createFetchMock({
      "https://example.test/trips?filter%5Bid%5D=trip-1%2Ctrip-2&include=shape&fields%5Btrip%5D=headsign%2Cshape&fields%5Bshape%5D=polyline&page%5Blimit%5D=1000":
        {
          data: [
            {
              id: "trip-1",
              attributes: { headsign: "Alewife" }
            },
            {
              id: "trip-2",
              attributes: { headsign: "Park" },
              relationships: {
                shape: { data: { id: "shape-2" } }
              }
            }
          ]
        }
    });

    const metadataByTripId = await fetchTripsByIds(
      ["trip-1", "trip-2"],
      "https://example.test",
      "/trips",
      fetchMock
    );

    expect(metadataByTripId).toEqual(
      new Map([
        [
          "trip-1",
          {
            destination: "Alewife",
            shapePolyline: null
          }
        ],
        [
          "trip-2",
          {
            destination: "Park",
            shapePolyline: null
          }
        ]
      ])
    );
  });

  it("returns an empty map and does not fetch for empty trip ids", async () => {
    const fetchMock = vi.fn();
    const result = await fetchTripsByIds([], "https://example.test", "/trips", fetchMock);

    expect(result).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});


describe("vehicle snapshots", () => {
  it("reuses included route colors, stops and valid trips across vehicle pages", async () => {
    const fetchMock = createFetchMock({
      "https://example.test/vehicles": {
        data: [{ id: "red-1", attributes: { latitude: 42.36, longitude: -71.08 },
          relationships: { route: { data: { id: "Red" } }, trip: { data: { id: "t1" } } } }],
        included: [
          { type: "route", id: "Red", attributes: { color: "DA291C", sort_order: 1 } },
          { type: "trip", id: "t1", attributes: { headsign: "Alewife" } }
        ],
        links: { next: "/vehicles?page=2" }
      },
      "https://example.test/vehicles?page=2": {
        data: [],
        included: [
          { type: "route", id: "77", attributes: { color: "FFC72C" } },
          { type: "stop", id: "s1", attributes: { name: "Central" } }
        ]
      }
    });
    const snapshot = await fetchVehicleSnapshot("https://example.test", "/vehicles", fetchMock);
    expect(snapshot.vehicles).toHaveLength(1);
    expect(snapshot.routes.map((r) => r.colorHex)).toEqual(["#da291c", "#ffc72c"]);
    expect(snapshot.trips.get("t1")?.destination).toBe("Alewife");
    expect(snapshot.stops.get("s1")).toBe("Central");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});


describe("backend path prefixes", () => {
  it("keeps the development proxy prefix for vehicles, stops, and trips", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => Response.json({ data: [] }));
    const base = "https://example.test/api/mbta/";
    await fetchVehicleSnapshot(base, "/vehicles", fetchMock);
    await fetchStopsByIds(["s1"], base, "/stops", fetchMock);
    await fetchTripsByIds(["t1"], base, "/trips", fetchMock);
    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname))
      .toEqual(["/api/mbta/vehicles", "/api/mbta/stops", "/api/mbta/trips"]);
  });
});


describe("stalled request recovery", () => {
  it("aborts a stalled production fetch and allows the next poll to succeed", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url: string | URL, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }))
      .mockResolvedValueOnce(Response.json({ data: [], included: [] }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const first = fetchVehicleSnapshot("https://proxy.test", "/vehicles");
      const rejected = expect(first).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(15_000);
      await rejected;
      await expect(fetchVehicleSnapshot("https://proxy.test", "/vehicles"))
        .resolves.toMatchObject({ vehicles: [] });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
