type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type MbtaFetch = FetchLike & { interactive: FetchLike };

// Leave room below the anonymous API allowance for pagination and tooltips.
const REQUEST_SPACING_MS = 3_500;
const DEFAULT_COOLDOWN_MS = 60_000;

function resetTime(response: Response, now: number): number {
  const retryAfter = response.headers.get("retry-after");
  const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
  const retryAt = retryAfter === null ? 0 :
    Number.isFinite(Number(retryAfter)) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter);
  return Math.max(Number.isFinite(reset) ? reset : 0, Number.isFinite(retryAt) ? retryAt : 0);
}

// The deadline starts when a queued request is dispatched, after spacing/cooldown.
// Buffering the body keeps the scheduler occupied until the entire request settles.
export function createMbtaFetch(
  fetchImpl: FetchLike,
  timeoutMs = 15_000,
  options: { spacingMs?: number } = {}
): MbtaFetch {
  let cooldownUntil = 0;
  const createQueue = (spacingMs: number): FetchLike => {
    let queue: Promise<unknown> = Promise.resolve();
    let nextRequestAt = 0;
    return (input, init) => {
      const request = queue.then(async () => {
        // Another queue can extend the shared cooldown while this request waits.
        while (true) {
          const waitMs = Math.max(nextRequestAt, cooldownUntil) - Date.now();
          if (waitMs <= 0) break;
          await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        }
        nextRequestAt = Date.now() + spacingMs;
        const controller = new AbortController();
        const cancel = () => controller.abort(init?.signal?.reason);
        init?.signal?.addEventListener("abort", cancel, { once: true });
        if (init?.signal?.aborted) cancel();
        const timer = setTimeout(() => controller.abort(new DOMException("MBTA request timed out", "TimeoutError")), timeoutMs);
        let rejectAbort: () => void = () => {};
        const aborted = new Promise<never>((_, reject) => {
          rejectAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener("abort", rejectAbort, { once: true });
          if (controller.signal.aborted) rejectAbort();
        });
        try {
          controller.signal.throwIfAborted();
          const response = await Promise.race([fetchImpl(input, { ...init, signal: controller.signal }), aborted]);
          const now = Date.now();
          if (response.status === 429 ||
              (response.status === 503 && response.headers.has("retry-after")) ||
              response.headers.get("x-ratelimit-remaining") === "0") {
            const resetAt = resetTime(response, now);
            cooldownUntil = Math.max(cooldownUntil, resetAt > now ? resetAt + 1000 : now + DEFAULT_COOLDOWN_MS);
          }
          const body = await Promise.race([response.arrayBuffer(), aborted]);
          return new Response(response.status === 204 || response.status === 205 || response.status === 304 ? null : body, {
            status: response.status, statusText: response.statusText, headers: response.headers
          });
        } finally {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", rejectAbort);
          init?.signal?.removeEventListener("abort", cancel);
        }
      });
      // A failed request must not prevent later requests from using the queue.
      queue = request.catch(() => undefined);
      return request;
    };
  };
  // Interactive proxy requests bypass polling and its spacing, but stay serial
  // with each other and share rate-limit cooldowns with the background queue.
  return Object.assign(createQueue(options.spacingMs ?? REQUEST_SPACING_MS), { interactive: createQueue(0) });
}
