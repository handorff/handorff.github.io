import type { VehicleCurrentStatus } from "./types";

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TooltipPositionOptions {
  anchorRect: RectLike;
  tooltipWidth: number;
  tooltipHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  marginPx: number;
}

const UNKNOWN_ROUTE = "Unknown route";
const UNKNOWN_DESTINATION = "Unknown destination";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

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

export function calculateTooltipPosition(options: TooltipPositionOptions): { left: number; top: number } {
  const minLeft = options.marginPx;
  const maxLeft = Math.max(minLeft, options.viewportWidth - options.tooltipWidth - options.marginPx);
  const minTop = options.marginPx;
  const maxTop = Math.max(minTop, options.viewportHeight - options.tooltipHeight - options.marginPx);

  const rightCandidate =
    options.anchorRect.left + options.anchorRect.width + options.marginPx;
  const leftCandidate = options.anchorRect.left - options.tooltipWidth - options.marginPx;
  const centeredCandidate =
    options.anchorRect.left + options.anchorRect.width / 2 - options.tooltipWidth / 2;

  let left = centeredCandidate;
  if (rightCandidate <= maxLeft) {
    left = rightCandidate;
  } else if (leftCandidate >= minLeft) {
    left = leftCandidate;
  }

  const topCandidate =
    options.anchorRect.top + options.anchorRect.height / 2 - options.tooltipHeight / 2;
  const top = clamp(topCandidate, minTop, maxTop);

  return {
    left: clamp(left, minLeft, maxLeft),
    top
  };
}
