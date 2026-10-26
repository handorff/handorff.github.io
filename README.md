# handorff.github.io

Abstract, live MBTA-powered background grid for a personal website. Vehicle locations are fetched from the MBTA v3 API and projected into fixed-size square cells over Cambridge/Somerville/downtown Boston.

## Local Development

Use Node.js 24.22.1 (LTS). The version is pinned in `.nvmrc`, which GitHub Actions also reads.

```bash
nvm install
nvm use
npm install
npm run dev
```

## Build and Preview

```bash
npm run build
npm run preview
```

## Run Tests

```bash
npm test
```

## Configuration

Primary app configuration is in `src/config.ts`:

- map center (Central Square): `lat 42.3655`, `lon -71.1038`
- map span (fixed zoom): `lat 0.115`, `lon 0.192`
- `bounds`:
  - `north: 42.4230`
  - `south: 42.3080`
  - `west: -71.1998`
  - `east: -71.0078`
- `geoCellSizeMeters: 283.3333333333`
- `cellSizePx: 40`
- `cellGapPx: 2`
- `pollIntervalMs: 10000`
- `transitionMs: 700`
- `fallbackColorHex: "#5f7380"`

## MBTA API Usage

The app polls `/vehicles` every 10 seconds, including sparse route, stop, and trip data in the same response. Route colors and tooltip labels use those included resources, so the app does not separately load all routes or batch-fetch trip metadata for the whole fleet. Pagination adds requests when necessary.

Route shapes are fetched and cached only when a vehicle is selected. Requests share a queue with at least 3.5 seconds between request starts. A 429 or an exhausted rate-limit response pauses the queue until `Retry-After` / `x-ratelimit-reset`, or 60 seconds when no usable reset is supplied. The last successful grid stays visible during failures. Background-tab polling is paused. Polling and animation restart when Back/Forward restores a page from the browser cache. The client honors the Worker’s `Retry-After` delay on temporary 503 outages as well as upstream rate limits.

The production frontend defaults to `https://mbta-proxy.handorff-paul.workers.dev`. Local development uses Vite’s `/api/mbta/` proxy to that same backend, avoiding browser-to-Worker connection issues. Requests time out after 15 seconds so a stalled connection cannot block subsequent polls. Override the public backend address with `VITE_MBTA_API_BASE_URL` (see `.env.example`). The MBTA API key lives only in the Worker's encrypted `MBTA_API_KEY` secret. Never put it in a Vite environment variable, which would embed it in public JavaScript.

## Caching Worker

The independently deployed backend source is `worker/index.js`, with configuration in `worker/wrangler.jsonc`. The site remains hosted on GitHub Pages. The Worker has fixed `/vehicles`, `/routes`, `/stops`, and `/trips` endpoints; it validates query parameters and allows at most 50 IDs per metadata request. It collects up to 10 upstream pages into one complete response, so clients never follow pagination directly to MBTA. Redirects and pagination to other hosts are rejected before the key can be forwarded.

Successful vehicle snapshots are fresh for 10 seconds, route metadata for one hour, trips/shapes for six hours, and stop names for one day. On upstream failure, vehicle data can be served for up to 60 additional seconds; metadata can be served for up to one additional hour. Failed or incomplete responses never replace successful cached data. Rate limits trigger a shared cooldown in that data center, using MBTA's reset headers (at least 60 seconds, capped at one hour).

Responses expose `X-Proxy-Cache` (`HIT`, `MISS`, or `STALE`) and `X-Data-Fetched-At` (Unix milliseconds). The current debug footer records when the browser received data; the header records when the backend fetched it. Browser responses use `no-store`; shared caching happens inside the Worker. CORS allows `paulhandorff.com`, `www.paulhandorff.com`, `handorff.github.io`, and HTTP localhost/127.0.0.1 development origins.

Cloudflare's Cache API stores data per data center. Concurrent misses are coalesced within an isolate, but there is no globally coordinated polling or strict per-client rate limiter. CORS is not authentication: direct non-browser clients can access these public transit endpoints. Requests use a fixed MBTA host and fixed fields, and equivalent metadata ID lists share a canonical cache key.

Cloudflare Workers Builds connects `handorff/handorff.github.io` to the existing `mbta-proxy` Worker. Pushes to `main` automatically run `npm test && npm run worker:check` from the repository root, then `npm run worker:deploy`. Preview builds are disabled. Wrangler is pinned in `package.json` and `package-lock.json`; deployment uses `worker/wrangler.jsonc`. The existing encrypted `MBTA_API_KEY` stays in Cloudflare and is not a build variable or GitHub secret. Cloudflare's build credential authenticates deployment separately from the MBTA runtime key.

The frontend and Worker deploy independently from the same push: GitHub Actions publishes the frontend to GitHub Pages, and Cloudflare Workers Builds publishes the backend. Check both deployment results after pushing; one can succeed while the other fails. Cloudflare's build commands and repository connection are dashboard settings under **mbta-proxy → Settings → Builds**.

For an authenticated local CLI deployment, run `npm run worker:deploy`. Validate bundling without deploying using `npm run worker:check`. Manual dashboard edits are overwritten by the next automated deployment, so make lasting changes in `worker/index.js` and commit them.

For local Worker development, place `MBTA_API_KEY=...` in the ignored `worker/.dev.vars` file and run `wrangler dev --config worker/wrangler.jsonc`. Set the frontend's `.env.local` to `VITE_MBTA_API_BASE_URL=http://localhost:8787`, then restart Vite. Never commit `.dev.vars` or key values. Unit tests mock MBTA and the cache, and run with `npm test` alongside the frontend tests.

## GitHub Pages Deployment

Deployment is configured via `.github/workflows/deploy-pages.yml`.

1. In the repository settings, open Pages.
2. Set source to **GitHub Actions**.
3. Push to `main` to trigger build and deploy.

The Vite `base` path is resolved automatically:

- `/` for `<user>.github.io` repositories
- `/<repo>/` for other repository names
