# handorff.github.io

Abstract, live MBTA-powered background grid for a personal website. Vehicle locations are fetched from the MBTA v3 API and projected into fixed-size square cells over Cambridge/Somerville/downtown Boston.

## Local Development

```bash
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

This app reads:

- `/vehicles?page[limit]=1000`
- `/routes?page[limit]=1000&fields[route]=color,sort_order`

No MBTA API key is used. Vehicle polling runs every 10 seconds (6 requests per minute).

## GitHub Pages Deployment

Deployment is configured via `.github/workflows/deploy-pages.yml`.

1. In the repository settings, open Pages.
2. Set source to **GitHub Actions**.
3. Push to `main` to trigger build and deploy.

The Vite `base` path is resolved automatically:

- `/` for `<user>.github.io` repositories
- `/<repo>/` for other repository names
