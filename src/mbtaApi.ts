import {
  MBTA_API_BASE_URL,
  MBTA_ROUTES_ENDPOINT,
  MBTA_STOPS_ENDPOINT,
  MBTA_TRIPS_ENDPOINT,
  MBTA_VEHICLES_ENDPOINT
} from "./config";
import type { RouteMeta, Vehicle, VehicleCurrentStatus } from "./types";

const JSON_API_ACCEPT = "application/vnd.api+json";
const HEX_COLOR_PATTERN = /^#?([0-9a-fA-F]{6})$/;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface JsonApiDocument<T> {
  data: T[];
  links?: {
    next?: string | null;
  };
}

interface JsonApiResource {
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, unknown>;
}

function buildUrl(baseUrl: string, endpoint: string): string {
  return new URL(endpoint, baseUrl).toString();
}

function resolveNextUrl(currentUrl: string, nextUrl: string): string {
  return new URL(nextUrl, currentUrl).toString();
}

async function fetchJsonDocument<T extends JsonApiResource>(
  url: string,
  fetchImpl: FetchLike
): Promise<JsonApiDocument<T>> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: JSON_API_ACCEPT
    }
  });

  if (!response.ok) {
    throw new Error(`MBTA request failed (${response.status}) for ${url}`);
  }

  return (await response.json()) as JsonApiDocument<T>;
}

export async function fetchPaginated<T extends JsonApiResource>(
  initialUrl: string,
  fetchImpl: FetchLike = fetch
): Promise<T[]> {
  const resources: T[] = [];
  const seenUrls = new Set<string>();

  let currentUrl: string | null = initialUrl;
  while (currentUrl) {
    if (seenUrls.has(currentUrl)) {
      throw new Error(`Detected pagination cycle at ${currentUrl}`);
    }
    seenUrls.add(currentUrl);

    const pageDocument: JsonApiDocument<T> = await fetchJsonDocument<T>(currentUrl, fetchImpl);
    resources.push(...pageDocument.data);

    const nextUrl: string | null | undefined = pageDocument.links?.next;
    currentUrl = typeof nextUrl === "string" && nextUrl.length > 0 ? resolveNextUrl(currentUrl, nextUrl) : null;
  }

  return resources;
}

export function normalizeColorHex(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = value.trim().match(HEX_COLOR_PATTERN);
  if (!match) {
    return null;
  }

  return `#${match[1].toLowerCase()}`;
}

export function normalizeSortOrder(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Number.POSITIVE_INFINITY;
}

function readRouteIdFromRelationships(relationships: Record<string, unknown> | undefined): string | null {
  if (!relationships) {
    return null;
  }

  const routeRel = relationships["route"];
  if (typeof routeRel !== "object" || routeRel === null) {
    return null;
  }

  const routeData = (routeRel as { data?: unknown }).data;
  if (typeof routeData !== "object" || routeData === null) {
    return null;
  }

  const routeId = (routeData as { id?: unknown }).id;
  return typeof routeId === "string" ? routeId : null;
}

function readStopIdFromRelationships(relationships: Record<string, unknown> | undefined): string | null {
  if (!relationships) {
    return null;
  }

  const stopRel = relationships["stop"];
  if (typeof stopRel !== "object" || stopRel === null) {
    return null;
  }

  const stopData = (stopRel as { data?: unknown }).data;
  if (typeof stopData !== "object" || stopData === null) {
    return null;
  }

  const stopId = (stopData as { id?: unknown }).id;
  return typeof stopId === "string" ? stopId : null;
}

function readTripIdFromRelationships(relationships: Record<string, unknown> | undefined): string | null {
  if (!relationships) {
    return null;
  }

  const tripRel = relationships["trip"];
  if (typeof tripRel !== "object" || tripRel === null) {
    return null;
  }

  const tripData = (tripRel as { data?: unknown }).data;
  if (typeof tripData !== "object" || tripData === null) {
    return null;
  }

  const tripId = (tripData as { id?: unknown }).id;
  return typeof tripId === "string" ? tripId : null;
}

function normalizeVehicleStatus(value: unknown): VehicleCurrentStatus | null {
  if (value === "IN_TRANSIT_TO" || value === "INCOMING_AT" || value === "STOPPED_AT") {
    return value;
  }

  return null;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function fetchVehicles(
  baseUrl: string = MBTA_API_BASE_URL,
  endpoint: string = MBTA_VEHICLES_ENDPOINT,
  fetchImpl: FetchLike = fetch
): Promise<Vehicle[]> {
  const url = buildUrl(baseUrl, endpoint);
  const resources = await fetchPaginated<JsonApiResource>(url, fetchImpl);

  const vehicles: Vehicle[] = [];
  for (const resource of resources) {
    const latitude = resource.attributes?.["latitude"];
    const longitude = resource.attributes?.["longitude"];
    if (typeof latitude !== "number" || typeof longitude !== "number") {
      continue;
    }

    vehicles.push({
      id: resource.id,
      routeId: readRouteIdFromRelationships(resource.relationships),
      latitude,
      longitude,
      destination: normalizeOptionalString(resource.attributes?.["destination"]),
      currentStatus: normalizeVehicleStatus(resource.attributes?.["current_status"]),
      relatedStopId: readStopIdFromRelationships(resource.relationships),
      relatedTripId: readTripIdFromRelationships(resource.relationships)
    });
  }

  return vehicles;
}

export async function fetchRoutes(
  baseUrl: string = MBTA_API_BASE_URL,
  endpoint: string = MBTA_ROUTES_ENDPOINT,
  fetchImpl: FetchLike = fetch
): Promise<RouteMeta[]> {
  const url = buildUrl(baseUrl, endpoint);
  const resources = await fetchPaginated<JsonApiResource>(url, fetchImpl);

  return resources.map((resource) => ({
    id: resource.id,
    colorHex: normalizeColorHex(resource.attributes?.["color"]),
    sortOrder: normalizeSortOrder(resource.attributes?.["sort_order"]),
    shortName: normalizeOptionalString(resource.attributes?.["short_name"]),
    longName: normalizeOptionalString(resource.attributes?.["long_name"])
  }));
}

function buildStopsByIdsUrl(baseUrl: string, endpoint: string, stopIds: string[]): string {
  const url = new URL(endpoint, baseUrl);
  url.searchParams.set("filter[id]", stopIds.join(","));
  url.searchParams.set("fields[stop]", "name");
  url.searchParams.set("page[limit]", "1000");
  return url.toString();
}

function buildTripsByIdsUrl(baseUrl: string, endpoint: string, tripIds: string[]): string {
  const url = new URL(endpoint, baseUrl);
  url.searchParams.set("filter[id]", tripIds.join(","));
  url.searchParams.set("fields[trip]", "headsign");
  url.searchParams.set("page[limit]", "1000");
  return url.toString();
}

export async function fetchStopsByIds(
  stopIds: string[],
  baseUrl: string = MBTA_API_BASE_URL,
  endpoint: string = MBTA_STOPS_ENDPOINT,
  fetchImpl: FetchLike = fetch
): Promise<Map<string, string>> {
  const uniqueStopIds = Array.from(
    new Set(
      stopIds
        .filter((stopId): stopId is string => typeof stopId === "string")
        .map((stopId) => stopId.trim())
        .filter((stopId) => stopId.length > 0)
    )
  );

  if (uniqueStopIds.length === 0) {
    return new Map<string, string>();
  }

  const url = buildStopsByIdsUrl(baseUrl, endpoint, uniqueStopIds);
  const resources = await fetchPaginated<JsonApiResource>(url, fetchImpl);
  const namesByStopId = new Map<string, string>();

  for (const resource of resources) {
    const name = normalizeOptionalString(resource.attributes?.["name"]);
    if (name) {
      namesByStopId.set(resource.id, name);
    }
  }

  return namesByStopId;
}

export async function fetchTripsByIds(
  tripIds: string[],
  baseUrl: string = MBTA_API_BASE_URL,
  endpoint: string = MBTA_TRIPS_ENDPOINT,
  fetchImpl: FetchLike = fetch
): Promise<Map<string, string>> {
  const uniqueTripIds = Array.from(
    new Set(
      tripIds
        .filter((tripId): tripId is string => typeof tripId === "string")
        .map((tripId) => tripId.trim())
        .filter((tripId) => tripId.length > 0)
    )
  );

  if (uniqueTripIds.length === 0) {
    return new Map<string, string>();
  }

  const url = buildTripsByIdsUrl(baseUrl, endpoint, uniqueTripIds);
  const resources = await fetchPaginated<JsonApiResource>(url, fetchImpl);
  const destinationByTripId = new Map<string, string>();

  for (const resource of resources) {
    const destination = normalizeOptionalString(resource.attributes?.["headsign"]);
    if (destination) {
      destinationByTripId.set(resource.id, destination);
    }
  }

  return destinationByTripId;
}
