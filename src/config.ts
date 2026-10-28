import type { GridConfig } from "./types";

export const MBTA_API_BASE_URL =
  import.meta.env.VITE_MBTA_API_BASE_URL ||
  (import.meta.env.DEV && typeof window !== "undefined"
    ? new URL("/api/mbta/", window.location.origin).href
    : "https://mbta-proxy.handorff-paul.workers.dev");
export const MBTA_VEHICLES_ENDPOINT =
  "/vehicles?page[limit]=1000&fields[vehicle]=latitude,longitude,current_status,destination,route,stop,trip&include=route,stop,trip&fields[route]=color,sort_order,short_name,long_name&fields[stop]=name&fields[trip]=headsign";
export const MBTA_ROUTES_ENDPOINT = "/routes?page[limit]=1000&fields[route]=color,sort_order,short_name,long_name";
export const MBTA_STOPS_ENDPOINT = "/stops";
export const MBTA_TRIPS_ENDPOINT = "/trips";

const MAP_SPAN_LAT = 0.115;
const MAP_SPAN_LON = 0.192;
const MAP_CENTER_LAT = 42.3655;
const MAP_CENTER_LON = -71.1038;

// Padded coverage for the full network, including the CapeFLYER to Hyannis.
// Verified against https://api-v3.mbta.com/stops?filter[location_type]=1
// Keep the initial Boston bounds below unchanged so the default view retains its scale.
export const SERVICE_AREA_BOUNDS = {
  north: 42.9,
  south: 41.45,
  west: -72,
  east: -70.15
};

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
