import {
  FALLBACK_COLOR_HEX,
  GRID_CONFIG,
  OCCUPIED_CELL_ALPHA
} from "./config";
import {
  calculateRenderGridDimensions,
  buildCellStateMap,
  buildRgbaBuffer,
  calculateGridDimensions
} from "./grid";
import { fetchRoutes, fetchVehicles } from "./mbtaApi";
import { createPollingLoop } from "./polling";
import { GridRenderer } from "./renderer";
import type { RouteMeta, Vehicle } from "./types";
import {
  applyTheme,
  createThemeState,
  getThemeGridLineColor,
  setContentLayerVisible
} from "./ui";
import "./styles.css";

function requireCanvas(selector: string): HTMLCanvasElement {
  const element = document.querySelector(selector);
  if (!element || !(element instanceof HTMLCanvasElement)) {
    throw new Error(`Missing required canvas element: ${selector}`);
  }
  return element;
}

function requireInput(selector: string): HTMLInputElement {
  const element = document.querySelector(selector);
  if (!element || !(element instanceof HTMLInputElement)) {
    throw new Error(`Missing required input element: ${selector}`);
  }
  return element;
}

function requireHtmlElement(selector: string): HTMLElement {
  const element = document.querySelector(selector);
  if (!element || !(element instanceof HTMLElement)) {
    throw new Error(`Missing required HTML element: ${selector}`);
  }
  return element;
}

function createRouteMap(routes: RouteMeta[]): Map<string, RouteMeta> {
  return new Map(routes.map((route) => [route.id, route]));
}

function sameDims(
  a: { rows: number; cols: number },
  b: { rows: number; cols: number }
): boolean {
  return a.rows === b.rows && a.cols === b.cols;
}

function bootstrap(): void {
  const canvas = requireCanvas("#grid-canvas");
  const contentOverlay = requireHtmlElement("#content-overlay");
  const content = requireHtmlElement("#site-content");
  const contentVisibilityToggle = requireInput("#toggle-content-visibility");
  const darkModeToggle = requireInput("#toggle-dark-mode");
  const themeState = createThemeState("light");

  applyTheme(themeState.getTheme());
  contentVisibilityToggle.checked = true;
  darkModeToggle.checked = false;
  setContentLayerVisible(content, contentOverlay, true);

  const baseDims = calculateGridDimensions(GRID_CONFIG);
  let renderDims = calculateRenderGridDimensions(
    baseDims,
    window.innerWidth,
    window.innerHeight,
    GRID_CONFIG.cellSizePx
  );

  const createRenderer = (): GridRenderer => {
    const instance = new GridRenderer({
      canvas,
      rows: renderDims.rows,
      cols: renderDims.cols,
      cellSizePx: GRID_CONFIG.cellSizePx,
      cellGapPx: GRID_CONFIG.cellGapPx,
      transitionMs: GRID_CONFIG.transitionMs,
      gridLineColor: getThemeGridLineColor(themeState.getTheme())
    });
    instance.resize(window.innerWidth, window.innerHeight);
    instance.start();
    return instance;
  };

  let renderer = createRenderer();

  contentVisibilityToggle.addEventListener("change", () => {
    setContentLayerVisible(content, contentOverlay, contentVisibilityToggle.checked);
  });

  darkModeToggle.addEventListener("change", () => {
    const nextTheme = themeState.setDarkModeEnabled(darkModeToggle.checked);
    applyTheme(nextTheme);
    renderer.setGridLineColor(getThemeGridLineColor(nextTheme));
  });

  let routesById = new Map<string, RouteMeta>();
  let latestVehicles: Vehicle[] = [];

  const computeBuffer = (vehicles: Vehicle[]): Float32Array => {
    const stateByCell = buildCellStateMap(
      vehicles,
      routesById,
      GRID_CONFIG.bounds,
      baseDims,
      renderDims,
      FALLBACK_COLOR_HEX
    );
    return buildRgbaBuffer(renderDims.cellCount, stateByCell, OCCUPIED_CELL_ALPHA);
  };

  const refreshVehicles = async (): Promise<void> => {
    try {
      const vehicles = await fetchVehicles();
      latestVehicles = vehicles;
      const nextBuffer = computeBuffer(vehicles);
      renderer.setState(nextBuffer);
    } catch (error) {
      console.error("Unable to refresh MBTA vehicles. Keeping current frame.", error);
    }
  };

  const pollingLoop = createPollingLoop({
    intervalMs: GRID_CONFIG.pollIntervalMs,
    task: refreshVehicles
  });

  const onVisibilityChange = (): void => {
    pollingLoop.setPaused(document.hidden);
  };

  void (async () => {
    try {
      const routes = await fetchRoutes();
      routesById = createRouteMap(routes);
    } catch (error) {
      console.error("Unable to fetch MBTA routes. Using fallback color.", error);
    }

    onVisibilityChange();
    pollingLoop.start();
  })();

  window.addEventListener("resize", () => {
    const nextRenderDims = calculateRenderGridDimensions(
      baseDims,
      window.innerWidth,
      window.innerHeight,
      GRID_CONFIG.cellSizePx
    );

    if (!sameDims(renderDims, nextRenderDims)) {
      renderDims = nextRenderDims;
      renderer.stop();
      renderer = createRenderer();
      renderer.setState(computeBuffer(latestVehicles));
      return;
    }

    renderer.resize(window.innerWidth, window.innerHeight);
  });
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", () => {
    pollingLoop.stop();
    renderer.stop();
  });
}

bootstrap();
