import type { Vehicle } from "./types";

// Keep only the latest hover/focus target and allow one speculative request at
// a time, so moving across tiles cannot fill the interactive request queue.
export function createShapePrefetcher(
  loadShape: (vehicle: Vehicle) => Promise<void>,
  onError: (error: unknown) => void,
  dwellMs = 120
): { target: (vehicle: Vehicle | null) => void; cancel: () => void } {
  let target: Vehicle | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let loading = false;

  const cancelTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = (): void => {
    if (!target || loading) return;
    timer = setTimeout(async () => {
      timer = null;
      const vehicle = target;
      if (!vehicle) return;
      loading = true;
      try {
        await loadShape(vehicle);
      } catch (error) {
        onError(error);
      } finally {
        loading = false;
        if (target?.relatedTripId !== vehicle.relatedTripId) schedule();
      }
    }, dwellMs);
  };
  return {
    target: (vehicle) => {
      if (target?.relatedTripId === vehicle?.relatedTripId) return;
      cancelTimer();
      target = vehicle;
      schedule();
    },
    cancel: () => {
      target = null;
      cancelTimer();
    }
  };
}
