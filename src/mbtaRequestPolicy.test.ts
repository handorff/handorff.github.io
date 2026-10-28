import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe("configured MBTA request policy", () => {
  it.each([
    ["https://proxy.example.test", 1_000, 0],
    ["http://localhost:5173/api/mbta/", 1_000, 0],
    ["https://api-v3.mbta.com", 3_500, 3_500]
  ])("applies the retry interval and request spacing for %s", async (baseUrl, retryMs, spacingMs) => {
    vi.useFakeTimers();
    vi.stubEnv("VITE_MBTA_API_BASE_URL", baseUrl);
    vi.resetModules();
    const fetchImpl = vi.fn(async () => new Response('{"data":[]}'));
    vi.stubGlobal("fetch", fetchImpl);
    const { MBTA_INITIAL_RETRY_INTERVAL_MS } = await import("./config");
    const { fetchVehicleSnapshot } = await import("./mbtaApi");
    expect(MBTA_INITIAL_RETRY_INTERVAL_MS).toBe(retryMs);

    await fetchVehicleSnapshot();
    const second = fetchVehicleSnapshot();
    await vi.advanceTimersByTimeAsync(0);
    if (spacingMs > 0) {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(spacingMs - 1);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
    }
    await second;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
