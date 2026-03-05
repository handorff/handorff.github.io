import { describe, expect, it } from "vitest";
import {
  calculateTooltipPosition,
  formatVehicleStatusLabel,
  formatVehicleTitle,
  wrapIndex
} from "./vehicleTooltip";

describe("formatVehicleStatusLabel", () => {
  it("maps MBTA statuses to required labels", () => {
    expect(formatVehicleStatusLabel("IN_TRANSIT_TO")).toBe("Next stop");
    expect(formatVehicleStatusLabel("INCOMING_AT")).toBe("Approaching");
    expect(formatVehicleStatusLabel("STOPPED_AT")).toBe("Now at");
    expect(formatVehicleStatusLabel(null)).toBe("Status unknown");
  });
});

describe("formatVehicleTitle", () => {
  it("formats route and destination in one title string", () => {
    expect(formatVehicleTitle({ routeLabel: "77", destination: "Harvard" })).toBe("77 to Harvard");
  });

  it("uses fallback labels when route or destination are missing", () => {
    expect(formatVehicleTitle({ routeLabel: null, destination: "Harvard" })).toBe(
      "Unknown route to Harvard"
    );
    expect(formatVehicleTitle({ routeLabel: "77", destination: null })).toBe(
      "77 to Unknown destination"
    );
  });
});

describe("wrapIndex", () => {
  it("wraps at both ends for tooltip pagination", () => {
    expect(wrapIndex(-1, 3)).toBe(2);
    expect(wrapIndex(3, 3)).toBe(0);
    expect(wrapIndex(5, 3)).toBe(2);
  });
});

describe("calculateTooltipPosition", () => {
  it("prefers placing tooltip to the right of the selected cell when space allows", () => {
    const result = calculateTooltipPosition({
      anchorRect: { left: 80, top: 100, width: 40, height: 40 },
      tooltipWidth: 200,
      tooltipHeight: 120,
      viewportWidth: 900,
      viewportHeight: 700,
      marginPx: 12
    });

    expect(result.left).toBe(132);
    expect(result.top).toBe(60);
  });

  it("clamps to viewport when there is no room on either side", () => {
    const result = calculateTooltipPosition({
      anchorRect: { left: 280, top: 10, width: 40, height: 40 },
      tooltipWidth: 380,
      tooltipHeight: 220,
      viewportWidth: 420,
      viewportHeight: 360,
      marginPx: 12
    });

    expect(result.left).toBe(28);
    expect(result.top).toBe(12);
  });
});
