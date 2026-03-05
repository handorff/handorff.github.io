import { describe, expect, it, vi } from "vitest";
import {
  fetchStopsByIds,
  fetchTripsByIds,
  fetchPaginated,
  fetchRoutes,
  fetchVehicles,
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
