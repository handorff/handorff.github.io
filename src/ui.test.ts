import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  createThemeState,
  getThemeGridLineColor,
  setContentLayerVisible,
  setContentVisible
} from "./ui";

describe("UI helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies the current theme via data-theme", () => {
    let storedTheme = "";
    const mockBody = {
      setAttribute: (name: string, value: string) => {
        if (name === "data-theme") {
          storedTheme = value;
        }
      }
    } as unknown as HTMLElement;

    applyTheme("dark", mockBody);
    expect(storedTheme).toBe("dark");
  });

  it("toggles content visibility using hidden", () => {
    const attributes = new Map<string, string>();
    const content = {
      inert: false,
      setAttribute: (name: string, value: string) => {
        attributes.set(name, value);
      }
    } as unknown as HTMLElement;

    setContentVisible(content, false);
    expect(content.inert).toBe(true);
    expect(attributes.get("aria-hidden")).toBe("true");

    setContentVisible(content, true);
    expect(content.inert).toBe(false);
    expect(attributes.get("aria-hidden")).toBe("false");
  });

  it("toggles both content and overlay visibility state", () => {
    const contentAttributes = new Map<string, string>();
    const content = {
      inert: false,
      setAttribute: (name: string, value: string) => {
        contentAttributes.set(name, value);
      }
    } as unknown as HTMLElement;
    const attributes = new Map<string, string>();
    const overlay = {
      setAttribute: (name: string, value: string) => {
        attributes.set(name, value);
      }
    } as unknown as HTMLElement;

    setContentLayerVisible(content, overlay, false);
    expect(content.inert).toBe(true);
    expect(contentAttributes.get("aria-hidden")).toBe("true");
    expect(attributes.get("data-content-visible")).toBe("false");

    setContentLayerVisible(content, overlay, true);
    expect(content.inert).toBe(false);
    expect(contentAttributes.get("aria-hidden")).toBe("false");
    expect(attributes.get("data-content-visible")).toBe("true");
  });

  it("returns the theme-specific grid line color token", () => {
    vi.stubGlobal(
      "getComputedStyle",
      (() => ({
        getPropertyValue: (token: string): string => {
          if (token === "--grid-line-color-light") {
            return "rgba(130, 138, 145, 0.16)";
          }
          if (token === "--grid-line-color-dark") {
            return "rgba(130, 138, 145, 0.28)";
          }
          return "";
        }
      })) as unknown as typeof getComputedStyle
    );

    expect(getThemeGridLineColor("light", {} as HTMLElement)).toBe("rgba(130, 138, 145, 0.16)");
    expect(getThemeGridLineColor("dark", {} as HTMLElement)).toBe("rgba(130, 138, 145, 0.28)");
  });

  it("keeps the selected theme for later renderer recreation", () => {
    const themeState = createThemeState("light");

    expect(themeState.getTheme()).toBe("light");
    themeState.setDarkModeEnabled(true);
    expect(themeState.getTheme()).toBe("dark");
  });
});
