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

Route shapes are fetched and cached only when a vehicle is selected. Requests share a queue with at least 3.5 seconds between request starts. A 429 or an exhausted rate-limit response pauses the queue until `Retry-After` / `x-ratelimit-reset`, or 60 seconds when no usable reset is supplied. The last successful grid stays visible during failures. Background-tab polling is paused.

No API key is currently used. Anonymous limits apply per IP, so multiple tabs or visitors sharing a network can still exhaust the allowance. An [MBTA API key](https://api-v3.mbta.com/) provides more headroom. For production use, a small caching proxy can hold the key and share one upstream vehicle feed across visitors. A key placed in a Vite environment variable would be embedded in the public GitHub Pages JavaScript, so it would not remain secret.

## GitHub Pages Deployment

Deployment is configured via `.github/workflows/deploy-pages.yml`.

1. In the repository settings, open Pages.
2. Set source to **GitHub Actions**.
3. Push to `main` to trigger build and deploy.

The Vite `base` path is resolved automatically:

- `/` for `<user>.github.io` repositories
- `/<repo>/` for other repository names
