interface PollingOptions {
  intervalMs: number;
  initialRetryIntervalMs?: number;
  // Return false when a refresh fails; a successful empty snapshot still counts.
  task: () => Promise<void | boolean>;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

export interface PollingLoop {
  start: () => void;
  stop: () => void;
  setPaused: (paused: boolean) => void;
  triggerNow: () => Promise<void>;
  isRunning: () => boolean;
  isInFlight: () => boolean;
}

export function createPollingLoop(options: PollingOptions): PollingLoop {
  const setIntervalRef = options.setIntervalFn ?? setInterval;
  const clearIntervalRef = options.clearIntervalFn ?? clearInterval;

  let timerId: ReturnType<typeof setInterval> | null = null;
  let paused = false;
  let inFlight = false;
  let hasSucceeded = false;

  const schedule = (): void => {
    timerId = setIntervalRef(() => {
      void tick();
    }, hasSucceeded ? options.intervalMs : options.initialRetryIntervalMs ?? options.intervalMs);
  };

  const tick = async (): Promise<void> => {
    if (paused || inFlight) {
      return;
    }

    inFlight = true;
    try {
      const succeeded = (await options.task()) !== false;
      if (succeeded && !hasSucceeded) {
        hasSucceeded = true;
        if (timerId !== null && options.initialRetryIntervalMs !== undefined) {
          clearIntervalRef(timerId);
          schedule();
        }
      }
    } finally {
      inFlight = false;
    }
  };

  return {
    start(): void {
      if (timerId !== null) {
        return;
      }

      schedule();

      void tick();
    },

    stop(): void {
      if (timerId !== null) {
        clearIntervalRef(timerId);
        timerId = null;
      }
    },

    setPaused(nextPaused: boolean): void {
      const wasPaused = paused;
      paused = nextPaused;
      if (wasPaused && !paused && timerId !== null) {
        void tick();
      }
    },

    triggerNow(): Promise<void> {
      return tick();
    },

    isRunning(): boolean {
      return timerId !== null;
    },

    isInFlight(): boolean {
      return inFlight;
    }
  };
}

// A page restored from the browser's back/forward cache keeps its old JS state.
export function bindPageLifecycle(
  target: EventTarget,
  suspend: () => void,
  resume: () => void
): void {
  target.addEventListener("pagehide", suspend);
  target.addEventListener("pageshow", (event) => {
    if ((event as PageTransitionEvent).persisted) resume();
  });
}
