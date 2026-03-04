export interface GeoBounds {
  north: number;
  south: number;
  west: number;
  east: number;
}

export interface GridConfig {
  bounds: GeoBounds;
  geoCellSizeMeters: number;
  cellSizePx: number;
  cellGapPx: number;
  pollIntervalMs: number;
  transitionMs: number;
}

export interface Vehicle {
  id: string;
  routeId: string | null;
  latitude: number;
  longitude: number;
}

export interface RouteMeta {
  id: string;
  colorHex: string | null;
  sortOrder: number;
}

export interface CellState {
  routeId: string;
  colorHex: string;
  sortOrder: number;
}

