import type { TripMetadata, Vehicle } from "./types";

export const LOADING_STOP_TEXT = "Loading stop...";
export const UNKNOWN_STOP_TEXT = "Unknown stop";
export const LOADING_DESTINATION_TEXT = "Loading destination...";
export const UNKNOWN_DESTINATION_TEXT = "Unknown destination";

interface TooltipMetadataStoreOptions {
  fetchStopsByIds: (stopIds: string[]) => Promise<Map<string, string>>;
  fetchTripsByIds: (tripIds: string[]) => Promise<Map<string, TripMetadata>>;
  onDataChanged?: () => void;
}

function normalizeId(id: string | null): string | null {
  if (!id) {
    return null;
  }

  const trimmed = id.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeText(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function selectMissingStopIds(
  vehicles: Vehicle[],
  stopCache: ReadonlyMap<string, string | null>,
  pendingStopIds: ReadonlySet<string>
): string[] {
  return Array.from(
    new Set(
      vehicles
        .map((vehicle) => normalizeId(vehicle.relatedStopId))
        .filter((stopId): stopId is string => stopId !== null)
        .filter((stopId) => !stopCache.has(stopId) && !pendingStopIds.has(stopId))
    )
  );
}

function selectMissingTripIds(
  vehicles: Vehicle[],
  tripCache: ReadonlyMap<string, TripMetadata | null>,
  pendingTripIds: ReadonlySet<string>
): string[] {
  return Array.from(
    new Set(
      vehicles
        .map((vehicle) => normalizeId(vehicle.relatedTripId))
        .filter((tripId): tripId is string => tripId !== null)
        .filter((tripId) => !tripCache.has(tripId) && !pendingTripIds.has(tripId))
    )
  );
}

export interface TooltipMetadataStore {
  setHiddenModeEnabled: (enabled: boolean) => void;
  prefetchFromVehicles: (vehicles: Vehicle[]) => Promise<void>;
  getStopText: (vehicle: Pick<Vehicle, "relatedStopId">) => string;
  getDestinationText: (vehicle: Pick<Vehicle, "relatedTripId" | "destination">) => string;
  getShapePolyline: (vehicle: Pick<Vehicle, "relatedTripId">) => string | null;
}

export function createTooltipMetadataStore(options: TooltipMetadataStoreOptions): TooltipMetadataStore {
  const stopCache = new Map<string, string | null>();
  const tripCache = new Map<string, TripMetadata | null>();
  const pendingStopIds = new Set<string>();
  const pendingTripIds = new Set<string>();

  let hiddenModeEnabled = false;
  let hiddenModeGeneration = 0;

  const notifyDataChanged = (): void => {
    options.onDataChanged?.();
  };

  const setHiddenModeEnabled = (enabled: boolean): void => {
    if (hiddenModeEnabled === enabled) {
      return;
    }

    hiddenModeEnabled = enabled;
    if (!enabled) {
      hiddenModeGeneration += 1;
    }
  };

  const prefetchFromVehicles = async (vehicles: Vehicle[]): Promise<void> => {
    if (!hiddenModeEnabled) {
      return;
    }

    const missingStopIds = selectMissingStopIds(vehicles, stopCache, pendingStopIds);
    const missingTripIds = selectMissingTripIds(vehicles, tripCache, pendingTripIds);
    if (missingStopIds.length === 0 && missingTripIds.length === 0) {
      return;
    }

    for (const stopId of missingStopIds) {
      pendingStopIds.add(stopId);
    }
    for (const tripId of missingTripIds) {
      pendingTripIds.add(tripId);
    }

    const generationAtRequestStart = hiddenModeGeneration;

    try {
      const [namesByStopId, metadataByTripId] = await Promise.all([
        missingStopIds.length > 0
          ? options.fetchStopsByIds(missingStopIds)
          : Promise.resolve(new Map<string, string>()),
        missingTripIds.length > 0
          ? options.fetchTripsByIds(missingTripIds)
          : Promise.resolve(new Map<string, TripMetadata>())
      ]);

      if (!hiddenModeEnabled || generationAtRequestStart !== hiddenModeGeneration) {
        return;
      }

      for (const stopId of missingStopIds) {
        stopCache.set(stopId, namesByStopId.get(stopId) ?? null);
      }

      for (const tripId of missingTripIds) {
        tripCache.set(tripId, metadataByTripId.get(tripId) ?? null);
      }

      notifyDataChanged();
    } finally {
      for (const stopId of missingStopIds) {
        pendingStopIds.delete(stopId);
      }
      for (const tripId of missingTripIds) {
        pendingTripIds.delete(tripId);
      }
    }
  };

  const getStopText = (vehicle: Pick<Vehicle, "relatedStopId">): string => {
    const stopId = normalizeId(vehicle.relatedStopId);
    if (!stopId) {
      return UNKNOWN_STOP_TEXT;
    }

    if (stopCache.has(stopId)) {
      return stopCache.get(stopId) ?? UNKNOWN_STOP_TEXT;
    }

    if (hiddenModeEnabled && pendingStopIds.has(stopId)) {
      return LOADING_STOP_TEXT;
    }

    if (hiddenModeEnabled) {
      return LOADING_STOP_TEXT;
    }

    return UNKNOWN_STOP_TEXT;
  };

  const getDestinationText = (vehicle: Pick<Vehicle, "relatedTripId" | "destination">): string => {
    const tripId = normalizeId(vehicle.relatedTripId);
    if (tripId) {
      if (tripCache.has(tripId)) {
        return tripCache.get(tripId)?.destination ?? UNKNOWN_DESTINATION_TEXT;
      }

      if (hiddenModeEnabled && pendingTripIds.has(tripId)) {
        return LOADING_DESTINATION_TEXT;
      }

      if (hiddenModeEnabled) {
        return LOADING_DESTINATION_TEXT;
      }
    }

    const destinationFallback = normalizeText(vehicle.destination);
    if (destinationFallback) {
      return destinationFallback;
    }

    return UNKNOWN_DESTINATION_TEXT;
  };

  const getShapePolyline = (vehicle: Pick<Vehicle, "relatedTripId">): string | null => {
    const tripId = normalizeId(vehicle.relatedTripId);
    if (!tripId) {
      return null;
    }

    return tripCache.get(tripId)?.shapePolyline ?? null;
  };

  return {
    setHiddenModeEnabled,
    prefetchFromVehicles,
    getStopText,
    getDestinationText,
    getShapePolyline
  };
}
