import type { CellState, GeoBounds, GridConfig, RouteMeta, Vehicle } from "./types";

export interface GridDimensions {
  rows: number;
  cols: number;
  cellCount: number;
}

export interface CellPlacement {
  row: number;
  col: number;
  index: number;
}

const METERS_PER_DEGREE_LAT = 111_132;

function metersPerDegreeLon(latitudeDegrees: number): number {
  return 111_320 * Math.cos((latitudeDegrees * Math.PI) / 180);
}

export function calculateGridDimensions(config: GridConfig): GridDimensions {
  const latSpan = Math.abs(config.bounds.north - config.bounds.south);
  const lonSpan = Math.abs(config.bounds.east - config.bounds.west);
  const midLat = (config.bounds.north + config.bounds.south) / 2;

  const northSouthMeters = latSpan * METERS_PER_DEGREE_LAT;
  const eastWestMeters = lonSpan * metersPerDegreeLon(midLat);

  const rows = Math.max(1, Math.ceil(northSouthMeters / config.geoCellSizeMeters));
  const cols = Math.max(1, Math.ceil(eastWestMeters / config.geoCellSizeMeters));

  return {
    rows,
    cols,
    cellCount: rows * cols
  };
}

export function calculateRenderGridDimensions(
  baseDims: GridDimensions,
  viewportWidthPx: number,
  viewportHeightPx: number,
  cellSizePx: number
): GridDimensions {
  const viewportCols = Math.ceil(viewportWidthPx / cellSizePx);
  const viewportRows = Math.ceil(viewportHeightPx / cellSizePx);

  const cols = Math.max(baseDims.cols, viewportCols);
  const rows = Math.max(baseDims.rows, viewportRows);

  return {
    rows,
    cols,
    cellCount: rows * cols
  };
}

export function latLonToCell(
  bounds: GeoBounds,
  baseDims: GridDimensions,
  latitude: number,
  longitude: number,
  renderDims: GridDimensions = baseDims
): CellPlacement | null {
  const xRatio = (longitude - bounds.west) / (bounds.east - bounds.west);
  const yRatio = (bounds.north - latitude) / (bounds.north - bounds.south);

  let worldCol = Math.floor(xRatio * baseDims.cols);
  let worldRow = Math.floor(yRatio * baseDims.rows);

  if (longitude === bounds.east) {
    worldCol = baseDims.cols - 1;
  }
  if (latitude === bounds.south) {
    worldRow = baseDims.rows - 1;
  }

  const colOffset = Math.floor((renderDims.cols - baseDims.cols) / 2);
  const rowOffset = Math.floor((renderDims.rows - baseDims.rows) / 2);

  const col = worldCol + colOffset;
  const row = worldRow + rowOffset;
  if (row < 0 || row >= renderDims.rows || col < 0 || col >= renderDims.cols) {
    return null;
  }

  const index = row * renderDims.cols + col;

  return { row, col, index };
}

function compareCellPriority(a: CellState, b: CellState): number {
  if (a.sortOrder !== b.sortOrder) {
    return a.sortOrder - b.sortOrder;
  }
  return a.routeId.localeCompare(b.routeId);
}

export function buildCellStateMap(
  vehicles: Vehicle[],
  routesById: ReadonlyMap<string, RouteMeta>,
  bounds: GeoBounds,
  baseDims: GridDimensions,
  renderDims: GridDimensions,
  fallbackColorHex: string
): Map<number, CellState> {
  const stateByCell = new Map<number, CellState>();

  for (const vehicle of vehicles) {
    if (!vehicle.routeId) {
      continue;
    }

    const placement = latLonToCell(bounds, baseDims, vehicle.latitude, vehicle.longitude, renderDims);
    if (!placement) {
      continue;
    }

    const routeMeta = routesById.get(vehicle.routeId);
    const candidate: CellState = {
      routeId: vehicle.routeId,
      colorHex: routeMeta?.colorHex ?? fallbackColorHex,
      sortOrder: routeMeta?.sortOrder ?? Number.POSITIVE_INFINITY
    };

    const existing = stateByCell.get(placement.index);
    if (!existing || compareCellPriority(candidate, existing) < 0) {
      stateByCell.set(placement.index, candidate);
    }
  }

  return stateByCell;
}

export function parseHexToRgb(colorHex: string): [number, number, number] | null {
  const match = colorHex.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!match) {
    return null;
  }

  const hex = match[1];
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return [red, green, blue];
}

export function buildRgbaBuffer(
  cellCount: number,
  stateByCell: ReadonlyMap<number, CellState>,
  occupiedAlpha: number
): Float32Array {
  const buffer = new Float32Array(cellCount * 4);

  for (const [cellIndex, cellState] of stateByCell.entries()) {
    const rgb = parseHexToRgb(cellState.colorHex);
    if (!rgb) {
      continue;
    }

    const offset = cellIndex * 4;
    buffer[offset] = rgb[0];
    buffer[offset + 1] = rgb[1];
    buffer[offset + 2] = rgb[2];
    buffer[offset + 3] = occupiedAlpha;
  }

  return buffer;
}

export interface SelectedVehicleBufferOptions {
  dimmedOccupiedAlpha: number;
  shapeCellIndices: ReadonlySet<number>;
  shapeColorHex: string;
  shapeAlpha: number;
  selectedCellIndex: number;
  selectedColorHex: string;
  selectedAlpha: number;
}

export function buildSelectedVehicleRgbaBuffer(
  cellCount: number,
  stateByCell: ReadonlyMap<number, CellState>,
  options: SelectedVehicleBufferOptions
): Float32Array {
  const buffer = new Float32Array(cellCount * 4);

  for (const [cellIndex, cellState] of stateByCell.entries()) {
    const rgb = parseHexToRgb(cellState.colorHex);
    if (!rgb) {
      continue;
    }

    const offset = cellIndex * 4;
    buffer[offset] = rgb[0];
    buffer[offset + 1] = rgb[1];
    buffer[offset + 2] = rgb[2];
    buffer[offset + 3] = options.dimmedOccupiedAlpha;
  }

  const shapeRgb = parseHexToRgb(options.shapeColorHex);
  if (shapeRgb) {
    for (const cellIndex of options.shapeCellIndices) {
      const offset = cellIndex * 4;
      buffer[offset] = shapeRgb[0];
      buffer[offset + 1] = shapeRgb[1];
      buffer[offset + 2] = shapeRgb[2];
      buffer[offset + 3] = options.shapeAlpha;
    }
  }

  const selectedRgb = parseHexToRgb(options.selectedColorHex);
  if (selectedRgb) {
    const offset = options.selectedCellIndex * 4;
    buffer[offset] = selectedRgb[0];
    buffer[offset + 1] = selectedRgb[1];
    buffer[offset + 2] = selectedRgb[2];
    buffer[offset + 3] = options.selectedAlpha;
  }

  return buffer;
}
