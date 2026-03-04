interface PollingOptions {
  intervalMs: number;
  task: () => Promise<void>;
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

  const tick = async (): Promise<void> => {
    if (paused || inFlight) {
      return;
    }

    inFlight = true;
    try {
      await options.task();
    } finally {
      inFlight = false;
    }
  };

  return {
    start(): void {
      if (timerId !== null) {
        return;
      }

      timerId = setIntervalRef(() => {
        void tick();
      }, options.intervalMs);

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
