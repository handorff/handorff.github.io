type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

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

export function createMbtaFetch(fetchImpl: FetchLike): FetchLike {
  let queue: Promise<unknown> = Promise.resolve();
  let nextRequestAt = 0;
  return (input, init) => {
    const request = queue.then(async () => {
      const waitMs = nextRequestAt - Date.now();
      if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      nextRequestAt = Date.now() + REQUEST_SPACING_MS;
      const response = await fetchImpl(input, init);
      const now = Date.now();
      if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0") {
        const resetAt = resetTime(response, now);
        nextRequestAt = Math.max(nextRequestAt, resetAt > now ? resetAt + 1000 : now + DEFAULT_COOLDOWN_MS);
      }
      return response;
    });
    // A failed request must not prevent later requests from using the queue.
    queue = request.catch(() => undefined);
    return request;
  };
}
