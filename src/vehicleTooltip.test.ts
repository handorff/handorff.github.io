import { describe, expect, it } from "vitest";
import {
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
