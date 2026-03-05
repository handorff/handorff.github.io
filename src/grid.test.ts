import { describe, expect, it } from "vitest";
import {
  buildCellStateMap,
  buildRgbaBuffer,
  calculateRenderGridDimensions,
  calculateGridDimensions,
  latLonToCell
} from "./grid";
import type { GridConfig, RouteMeta, Vehicle } from "./types";

describe("grid mapping", () => {
  const config: GridConfig = {
    bounds: {
      north: 42.424,
      south: 42.309,
      west: -71.172,
      east: -70.98
    },
    geoCellSizeMeters: 850,
    cellSizePx: 20,
    cellGapPx: 2,
    pollIntervalMs: 10_000,
    transitionMs: 700
  };

  it("calculates positive row and column counts from bounds", () => {
    const dims = calculateGridDimensions(config);
    expect(dims.rows).toBeGreaterThan(0);
    expect(dims.cols).toBeGreaterThan(0);
    expect(dims.cellCount).toBe(dims.rows * dims.cols);
  });

  it("maps in-bounds and boundary coordinates into cells", () => {
    const dims = calculateGridDimensions(config);

    const centerCell = latLonToCell(config.bounds, dims, 42.366, -71.09);
    expect(centerCell).not.toBeNull();
    expect(centerCell?.row).toBeGreaterThanOrEqual(0);
    expect(centerCell?.col).toBeGreaterThanOrEqual(0);

    const northEastCell = latLonToCell(config.bounds, dims, config.bounds.north, config.bounds.east);
    expect(northEastCell).toEqual({
      row: 0,
      col: dims.cols - 1,
      index: dims.cols - 1
    });

    const southWestCell = latLonToCell(config.bounds, dims, config.bounds.south, config.bounds.west);
    expect(southWestCell).toEqual({
      row: dims.rows - 1,
      col: 0,
      index: (dims.rows - 1) * dims.cols
    });
  });

  it("returns null when out-of-bounds points are outside the base render grid", () => {
    const dims = calculateGridDimensions(config);
    expect(latLonToCell(config.bounds, dims, 43.0, -71.09)).toBeNull();
    expect(latLonToCell(config.bounds, dims, 42.366, -72.0)).toBeNull();
  });

  it("preserves true out-of-bounds positions when a larger render grid can display them", () => {
    const baseDims = {
      rows: 2,
      cols: 2,
      cellCount: 4
    };
    const renderDims = {
      rows: 6,
      cols: 6,
      cellCount: 36
    };
    const bounds = {
      north: 10,
      south: 0,
      west: 0,
      east: 10
    };

    const westOfBounds = latLonToCell(bounds, baseDims, 5, -1, renderDims);
    expect(westOfBounds).toEqual({
      row: 3,
      col: 1,
      index: 19
    });
  });

  it("expands render grid to viewport size while preserving base zoom", () => {
    const baseDims = {
      rows: 16,
      cols: 19,
      cellCount: 304
    };
    const renderDims = calculateRenderGridDimensions(baseDims, 1600, 900, 40);
    expect(renderDims.cols).toBe(40);
    expect(renderDims.rows).toBe(23);
  });
});

describe("cell winner selection", () => {
  const bounds = {
    north: 10,
    south: 0,
    west: 0,
    east: 10
  };
  const dims = {
    rows: 2,
    cols: 2,
    cellCount: 4
  };

  it("uses the route with the smallest sort_order in a shared cell", () => {
    const vehicles: Vehicle[] = [
      {
        id: "v1",
        routeId: "r1",
        latitude: 9.9,
        longitude: 0.1,
        destination: null,
        currentStatus: null,
        relatedStopId: null,
        relatedTripId: null
      },
      {
        id: "v2",
        routeId: "r2",
        latitude: 9.8,
        longitude: 0.2,
        destination: null,
        currentStatus: null,
        relatedStopId: null,
        relatedTripId: null
      }
    ];
    const routesById = new Map<string, RouteMeta>([
      ["r1", { id: "r1", colorHex: "#ff0000", sortOrder: 5, shortName: "R1", longName: "Route 1" }],
      ["r2", { id: "r2", colorHex: "#00ff00", sortOrder: 1, shortName: "R2", longName: "Route 2" }]
    ]);

    const stateByCell = buildCellStateMap(vehicles, routesById, bounds, dims, dims, "#5f7380");
    const winner = stateByCell.get(0);
    expect(winner?.routeId).toBe("r2");
    expect(winner?.colorHex).toBe("#00ff00");
  });

  it("uses route id lexical order as tie-breaker for equal sort_order", () => {
    const vehicles: Vehicle[] = [
      {
        id: "v1",
        routeId: "z-route",
        latitude: 9.9,
        longitude: 0.1,
        destination: null,
        currentStatus: null,
        relatedStopId: null,
        relatedTripId: null
      },
      {
        id: "v2",
        routeId: "a-route",
        latitude: 9.8,
        longitude: 0.2,
        destination: null,
        currentStatus: null,
        relatedStopId: null,
        relatedTripId: null
      }
    ];
    const routesById = new Map<string, RouteMeta>([
      [
        "z-route",
        { id: "z-route", colorHex: "#aaaaaa", sortOrder: 10, shortName: "Z", longName: "Z Route" }
      ],
      [
        "a-route",
        { id: "a-route", colorHex: "#bbbbbb", sortOrder: 10, shortName: "A", longName: "A Route" }
      ]
    ]);

    const stateByCell = buildCellStateMap(vehicles, routesById, bounds, dims, dims, "#5f7380");
    expect(stateByCell.get(0)?.routeId).toBe("a-route");
  });

  it("falls back to configured color when route color is missing", () => {
    const vehicles: Vehicle[] = [
      {
        id: "v1",
        routeId: "r1",
        latitude: 9.9,
        longitude: 0.1,
        destination: null,
        currentStatus: null,
        relatedStopId: null,
        relatedTripId: null
      }
    ];
    const routesById = new Map<string, RouteMeta>([
      ["r1", { id: "r1", colorHex: null, sortOrder: 1, shortName: "R1", longName: "Route 1" }]
    ]);

    const stateByCell = buildCellStateMap(vehicles, routesById, bounds, dims, dims, "#5f7380");
    const buffer = buildRgbaBuffer(dims.cellCount, stateByCell, 0.88);
    expect(buffer[0]).toBe(95);
    expect(buffer[1]).toBe(115);
    expect(buffer[2]).toBe(128);
    expect(buffer[3]).toBeCloseTo(0.88);
  });
});
