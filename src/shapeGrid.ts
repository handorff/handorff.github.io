import { latLonToCell, type GridDimensions } from "./grid";
import type { GeoBounds } from "./types";

export interface LatLonPoint {
  latitude: number;
  longitude: number;
}

function decodeCoordinate(encoded: string, startIndex: number): { value: number; nextIndex: number } | null {
  let result = 0;
  let shift = 0;
  let index = startIndex;

  while (index < encoded.length) {
    const byte = encoded.charCodeAt(index) - 63;
    index += 1;
    result |= (byte & 0x1f) << shift;
    shift += 5;

    if (byte < 0x20) {
      const value = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
      return { value, nextIndex: index };
    }
  }

  return null;
}

export function decodeGooglePolyline(encoded: string): LatLonPoint[] {
  const trimmed = encoded.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const points: LatLonPoint[] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  while (index < trimmed.length) {
    const latChunk = decodeCoordinate(trimmed, index);
    if (!latChunk) {
      return [];
    }
    index = latChunk.nextIndex;

    const lonChunk = decodeCoordinate(trimmed, index);
    if (!lonChunk) {
      return [];
    }
    index = lonChunk.nextIndex;

    latitude += latChunk.value;
    longitude += lonChunk.value;

    points.push({
      latitude: latitude / 1e5,
      longitude: longitude / 1e5
    });
  }

  return points;
}

function estimateInterpolationSteps(
  start: LatLonPoint,
  end: LatLonPoint,
  bounds: GeoBounds,
  baseDims: GridDimensions
): number {
  const lonSpan = Math.max(1e-9, Math.abs(bounds.east - bounds.west));
  const latSpan = Math.max(1e-9, Math.abs(bounds.north - bounds.south));

  const colDelta = Math.abs(((end.longitude - start.longitude) / lonSpan) * baseDims.cols);
  const rowDelta = Math.abs(((end.latitude - start.latitude) / latSpan) * baseDims.rows);
  const maxDelta = Math.max(colDelta, rowDelta);

  return Math.max(1, Math.ceil(maxDelta * 2));
}

export function rasterizeShapeToCellIndices(
  encodedPolyline: string,
  bounds: GeoBounds,
  baseDims: GridDimensions,
  renderDims: GridDimensions = baseDims
): Set<number> {
  const points = decodeGooglePolyline(encodedPolyline);
  if (points.length === 0) {
    return new Set<number>();
  }

  const cellIndices = new Set<number>();
  const addPoint = (point: LatLonPoint): void => {
    const placement = latLonToCell(bounds, baseDims, point.latitude, point.longitude, renderDims);
    if (placement) {
      cellIndices.add(placement.index);
    }
  };

  addPoint(points[0]);

  for (let i = 1; i < points.length; i += 1) {
    const start = points[i - 1];
    const end = points[i];
    const stepCount = estimateInterpolationSteps(start, end, bounds, baseDims);

    for (let step = 1; step <= stepCount; step += 1) {
      const t = step / stepCount;
      addPoint({
        latitude: start.latitude + (end.latitude - start.latitude) * t,
        longitude: start.longitude + (end.longitude - start.longitude) * t
      });
    }
  }

  return cellIndices;
}
