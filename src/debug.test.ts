import { describe, expect, it } from "vitest";
import { formatDebugTimestamp, isDebugModeEnabled } from "./debug";

describe("debug helpers", () => {
  it("enables debug mode only for debug=true", () => {
    expect(isDebugModeEnabled("?debug=true")).toBe(true);
    expect(isDebugModeEnabled("?debug=false")).toBe(false);
    expect(isDebugModeEnabled("?debug=True")).toBe(false);
    expect(isDebugModeEnabled("?foo=bar")).toBe(false);
  });

  it("formats missing timestamps as not loaded", () => {
    expect(formatDebugTimestamp(null)).toBe("Not loaded");
  });

  it("formats timestamps with seconds", () => {
    const timestamp = new Date("2026-03-22T15:04:05.000Z");

    expect(formatDebugTimestamp(timestamp, "en-US", "UTC")).toBe("3:04:05 PM");
  });
});
