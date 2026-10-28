import type { VehicleCurrentStatus } from "./types";

const UNKNOWN_ROUTE = "Unknown route";
const UNKNOWN_DESTINATION = "Unknown destination";

export function formatVehicleTitle(vehicle: {
  routeLabel: string | null;
  destination: string | null;
}): string {
  const route = vehicle.routeLabel?.trim() || UNKNOWN_ROUTE;
  const destination = vehicle.destination?.trim() || UNKNOWN_DESTINATION;
  return `${route} to ${destination}`;
}

export function formatVehicleStatusLabel(status: VehicleCurrentStatus | null): string {
  if (status === "IN_TRANSIT_TO") {
    return "Next stop";
  }
  if (status === "INCOMING_AT") {
    return "Approaching";
  }
  if (status === "STOPPED_AT") {
    return "Now at";
  }
  return "Status unknown";
}

export function wrapIndex(index: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  const normalized = index % total;
  return normalized >= 0 ? normalized : normalized + total;
}
