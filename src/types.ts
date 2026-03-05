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
  destination: string | null;
  currentStatus: VehicleCurrentStatus | null;
  relatedStopId: string | null;
  relatedTripId: string | null;
}

export type VehicleCurrentStatus = "IN_TRANSIT_TO" | "INCOMING_AT" | "STOPPED_AT";

export interface StopMeta {
  id: string;
  name: string;
}

export interface TripMeta {
  id: string;
  headsign: string;
}

export interface TripMetadata {
  destination: string | null;
  shapePolyline: string | null;
}

export interface RouteMeta {
  id: string;
  colorHex: string | null;
  sortOrder: number;
  shortName: string | null;
  longName: string | null;
}

export interface CellState {
  routeId: string;
  colorHex: string;
  sortOrder: number;
}
