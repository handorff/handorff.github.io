import { describe, expect, it } from "vitest";
import type { GeoBounds } from "./types";
import { decodeGooglePolyline, rasterizeShapeToCellIndices } from "./shapeGrid";

describe("shape grid utilities", () => {
  it("decodes google encoded polyline points", () => {
    const points = decodeGooglePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    expect(points).toEqual([
      { latitude: 38.5, longitude: -120.2 },
      { latitude: 40.7, longitude: -120.95 },
      { latitude: 43.252, longitude: -126.453 }
    ]);
  });

  it("rasterizes interpolated segments across multiple grid cells", () => {
    const bounds: GeoBounds = {
      north: 44,
      south: 38,
      west: -127,
      east: -120
    };
    const dims = {
      rows: 12,
      cols: 14,
      cellCount: 168
    };

    const cells = rasterizeShapeToCellIndices(
      "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
      bounds,
      dims,
      dims
    );

    expect(cells.size).toBeGreaterThan(3);
  });

  it("returns empty cells for malformed polylines", () => {
    const bounds: GeoBounds = {
      north: 44,
      south: 38,
      west: -127,
      east: -120
    };
    const dims = {
      rows: 12,
      cols: 14,
      cellCount: 168
    };

    const cells = rasterizeShapeToCellIndices("_p~iF~ps|U_bad", bounds, dims, dims);
    expect(cells.size).toBe(0);
  });

  it("handles partially out-of-bounds shapes without throwing", () => {
    const bounds: GeoBounds = {
      north: 41.2,
      south: 40.2,
      west: -121.2,
      east: -120.6
    };
    const dims = {
      rows: 8,
      cols: 8,
      cellCount: 64
    };

    const cells = rasterizeShapeToCellIndices(
      "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
      bounds,
      dims,
      dims
    );
    expect(cells.size).toBeGreaterThanOrEqual(1);
  });
});
