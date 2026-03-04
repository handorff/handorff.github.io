import { describe, expect, it, vi } from "vitest";
import {
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
            attributes: { latitude: 42.36, longitude: -71.08 },
            relationships: { route: { data: { id: "Red" } } }
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
        longitude: -71.08
      }
    ]);
  });

  it("maps /routes payloads to route metadata", async () => {
    const fetchMock = createFetchMock({
      "https://example.test/routes": {
        data: [
          {
            id: "Red",
            attributes: { color: "DA291C", sort_order: 10 }
          },
          {
            id: "Mystery",
            attributes: { color: "invalid", sort_order: null }
          }
        ]
      }
    });

    const routes = await fetchRoutes("https://example.test", "/routes", fetchMock);
    expect(routes).toEqual([
      { id: "Red", colorHex: "#da291c", sortOrder: 10 },
      { id: "Mystery", colorHex: null, sortOrder: Number.POSITIVE_INFINITY }
    ]);
  });
});

