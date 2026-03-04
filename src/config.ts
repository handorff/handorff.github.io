import type { GridConfig } from "./types";

export const MBTA_API_BASE_URL = "https://api-v3.mbta.com";
export const MBTA_VEHICLES_ENDPOINT = "/vehicles?page[limit]=1000";
export const MBTA_ROUTES_ENDPOINT = "/routes?page[limit]=1000&fields[route]=color,sort_order";

const MAP_SPAN_LAT = 0.115;
const MAP_SPAN_LON = 0.192;
const MAP_CENTER_LAT = 42.3655;
const MAP_CENTER_LON = -71.1038;

export const GRID_CONFIG: GridConfig = {
  bounds: {
    north: MAP_CENTER_LAT + MAP_SPAN_LAT / 2,
    south: MAP_CENTER_LAT - MAP_SPAN_LAT / 2,
    west: MAP_CENTER_LON - MAP_SPAN_LON / 2,
    east: MAP_CENTER_LON + MAP_SPAN_LON / 2
  },
  geoCellSizeMeters: 283.3333333333,
  cellSizePx: 40,
  cellGapPx: 2,
  pollIntervalMs: 10_000,
  transitionMs: 700
};

export const FALLBACK_COLOR_HEX = "#5f7380";
export const OCCUPIED_CELL_ALPHA = 0.88;
