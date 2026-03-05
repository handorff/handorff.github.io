import {
  FALLBACK_COLOR_HEX,
  GRID_CONFIG,
  OCCUPIED_CELL_ALPHA
} from "./config";
import {
  calculateRenderGridDimensions,
  buildCellStateMap,
  buildRgbaBuffer,
  calculateGridDimensions,
  latLonToCell
} from "./grid";
import { fetchRoutes, fetchStopsByIds, fetchTripsByIds, fetchVehicles } from "./mbtaApi";
import { createPollingLoop } from "./polling";
import { GridRenderer } from "./renderer";
import type { RouteMeta, Vehicle } from "./types";
import {
  applyTheme,
  createThemeState,
  getThemeGridLineColor,
  setContentLayerVisible
} from "./ui";
import {
  calculateTooltipPosition,
  formatVehicleStatusLabel,
  formatVehicleTitle,
  wrapIndex
} from "./vehicleTooltip";
import { createTooltipMetadataStore } from "./tooltipMetadata";
import "./styles.css";

const TOOLTIP_MARGIN_PX = 12;

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

function requireButton(selector: string): HTMLButtonElement {
  const element = document.querySelector(selector);
  if (!element || !(element instanceof HTMLButtonElement)) {
    throw new Error(`Missing required button element: ${selector}`);
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
  const hoverOutline = requireHtmlElement("#grid-hover-outline");
  const tooltip = requireHtmlElement("#vehicle-tooltip");
  const tooltipTitle = requireHtmlElement("#vehicle-tooltip-title");
  const tooltipStatus = requireHtmlElement("#vehicle-tooltip-status");
  const tooltipStop = requireHtmlElement("#vehicle-tooltip-stop");
  const tooltipIndex = requireHtmlElement("#vehicle-tooltip-index");
  const tooltipPrev = requireButton("#vehicle-tooltip-prev");
  const tooltipNext = requireButton("#vehicle-tooltip-next");
  const themeState = createThemeState("light");
  const finePointerMediaQuery =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(hover: hover) and (pointer: fine)")
      : null;

  applyTheme(themeState.getTheme());
  contentVisibilityToggle.checked = true;
  darkModeToggle.checked = false;
  setContentLayerVisible(content, contentOverlay, true);
  hoverOutline.setAttribute("data-visible", "false");
  tooltip.setAttribute("data-open", "false");
  tooltip.hidden = true;

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
  let routesById = new Map<string, RouteMeta>();
  let latestVehicles: Vehicle[] = [];
  let isContentVisible = true;
  let selectedCellIndex: number | null = null;
  let selectedVehicleOffset = 0;
  let renderTooltipForSelection: (() => void) | null = null;

  const tooltipMetadata = createTooltipMetadataStore({
    fetchStopsByIds,
    fetchTripsByIds,
    onDataChanged: () => {
      if (selectedCellIndex !== null && !isContentVisible) {
        renderTooltipForSelection?.();
      }
    }
  });

  const getRouteSortOrder = (routeId: string | null): number => {
    if (!routeId) {
      return Number.POSITIVE_INFINITY;
    }
    return routesById.get(routeId)?.sortOrder ?? Number.POSITIVE_INFINITY;
  };

  const getRouteLabel = (routeId: string | null): string | null => {
    if (!routeId) {
      return null;
    }

    const route = routesById.get(routeId);
    const shortName = route?.shortName?.trim();
    if (shortName && shortName.length > 0) {
      return shortName;
    }

    const longName = route?.longName?.trim();
    if (longName && longName.length > 0) {
      return longName;
    }

    return routeId;
  };

  const canShowHoverOutline = (): boolean =>
    !isContentVisible && Boolean(finePointerMediaQuery?.matches);

  const hideHoverOutline = (): void => {
    hoverOutline.setAttribute("data-visible", "false");
  };

  const hideTooltip = (): void => {
    tooltip.setAttribute("data-open", "false");
    tooltip.hidden = true;
  };

  const clearSelection = (): void => {
    selectedCellIndex = null;
    selectedVehicleOffset = 0;
    hideTooltip();
  };

  const getVehiclesInCell = (cellIndex: number, vehicles: Vehicle[] = latestVehicles): Vehicle[] => {
    const inCell: Vehicle[] = [];

    for (const vehicle of vehicles) {
      const placement = latLonToCell(
        GRID_CONFIG.bounds,
        baseDims,
        vehicle.latitude,
        vehicle.longitude,
        renderDims
      );

      if (placement?.index === cellIndex) {
        inCell.push(vehicle);
      }
    }

    inCell.sort((a, b) => {
      const sortOrderDiff = getRouteSortOrder(a.routeId) - getRouteSortOrder(b.routeId);
      if (sortOrderDiff !== 0) {
        return sortOrderDiff;
      }

      const routeLabelDiff = (getRouteLabel(a.routeId) ?? "").localeCompare(getRouteLabel(b.routeId) ?? "");
      if (routeLabelDiff !== 0) {
        return routeLabelDiff;
      }

      const destinationCompare = (a.destination ?? "").localeCompare(b.destination ?? "");
      if (destinationCompare !== 0) {
        return destinationCompare;
      }

      return a.id.localeCompare(b.id);
    });
    return inCell;
  };

  const positionTooltipForCell = (cellIndex: number): void => {
    const row = Math.floor(cellIndex / renderDims.cols);
    const col = cellIndex % renderDims.cols;

    if (row < 0 || row >= renderDims.rows || col < 0 || col >= renderDims.cols) {
      return;
    }

    const cellRect = renderer.getCellRect(row, col);
    const position = calculateTooltipPosition({
      anchorRect: cellRect,
      tooltipWidth: tooltip.offsetWidth,
      tooltipHeight: tooltip.offsetHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      marginPx: TOOLTIP_MARGIN_PX
    });
    tooltip.style.left = `${position.left}px`;
    tooltip.style.top = `${position.top}px`;
  };

  const updateHoverOutline = (cellIndex: number): void => {
    const row = Math.floor(cellIndex / renderDims.cols);
    const col = cellIndex % renderDims.cols;
    if (row < 0 || row >= renderDims.rows || col < 0 || col >= renderDims.cols) {
      hideHoverOutline();
      return;
    }

    const cellRect = renderer.getCellRect(row, col);
    hoverOutline.style.left = `${cellRect.left}px`;
    hoverOutline.style.top = `${cellRect.top}px`;
    hoverOutline.style.width = `${cellRect.width}px`;
    hoverOutline.style.height = `${cellRect.height}px`;
    hoverOutline.setAttribute("data-visible", "true");
  };

  renderTooltipForSelection = (): void => {
    if (selectedCellIndex === null || isContentVisible) {
      hideTooltip();
      return;
    }

    const vehiclesInCell = getVehiclesInCell(selectedCellIndex);
    if (vehiclesInCell.length === 0) {
      clearSelection();
      return;
    }

    selectedVehicleOffset = wrapIndex(selectedVehicleOffset, vehiclesInCell.length);
    const vehicle = vehiclesInCell[selectedVehicleOffset];
    const destination = tooltipMetadata.getDestinationText(vehicle);
    const stopName = tooltipMetadata.getStopText(vehicle);

    tooltipTitle.textContent = formatVehicleTitle({
      routeLabel: getRouteLabel(vehicle.routeId),
      destination
    });
    tooltipStatus.textContent = formatVehicleStatusLabel(vehicle.currentStatus);
    tooltipStop.textContent = stopName;
    tooltipIndex.textContent = `${selectedVehicleOffset + 1}/${vehiclesInCell.length}`;

    const disablePagination = vehiclesInCell.length <= 1;
    tooltipPrev.disabled = disablePagination;
    tooltipNext.disabled = disablePagination;

    tooltip.hidden = false;
    tooltip.setAttribute("data-open", "true");
    positionTooltipForCell(selectedCellIndex);
  };

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

      if (!isContentVisible) {
        void tooltipMetadata.prefetchFromVehicles(vehicles).catch((error) => {
          console.error("Unable to prefetch tooltip metadata.", error);
        });
      }

      if (selectedCellIndex !== null && !isContentVisible) {
        const vehiclesInSelectedCell = getVehiclesInCell(selectedCellIndex, vehicles);
        if (vehiclesInSelectedCell.length === 0) {
          clearSelection();
        } else {
          selectedVehicleOffset = Math.min(selectedVehicleOffset, vehiclesInSelectedCell.length - 1);
          renderTooltipForSelection?.();
        }
      }
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

  contentVisibilityToggle.addEventListener("change", () => {
    isContentVisible = contentVisibilityToggle.checked;
    tooltipMetadata.setHiddenModeEnabled(!isContentVisible);
    setContentLayerVisible(content, contentOverlay, isContentVisible);

    if (isContentVisible) {
      clearSelection();
      hideHoverOutline();
      return;
    }

    void tooltipMetadata.prefetchFromVehicles(latestVehicles).catch((error) => {
      console.error("Unable to prefetch tooltip metadata.", error);
    });
  });

  darkModeToggle.addEventListener("change", () => {
    const nextTheme = themeState.setDarkModeEnabled(darkModeToggle.checked);
    applyTheme(nextTheme);
    renderer.setGridLineColor(getThemeGridLineColor(nextTheme));
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!canShowHoverOutline()) {
      hideHoverOutline();
      return;
    }

    const hoveredCell = renderer.getCellFromViewportPoint(event.clientX, event.clientY);
    if (!hoveredCell) {
      hideHoverOutline();
      return;
    }

    updateHoverOutline(hoveredCell.index);
  });

  canvas.addEventListener("pointerleave", () => {
    hideHoverOutline();
  });

  canvas.addEventListener("click", (event) => {
    if (isContentVisible) {
      return;
    }

    const clickedCell = renderer.getCellFromViewportPoint(event.clientX, event.clientY);
    if (!clickedCell) {
      clearSelection();
      return;
    }

    const vehiclesInCell = getVehiclesInCell(clickedCell.index);
    if (vehiclesInCell.length === 0) {
      clearSelection();
      return;
    }

    selectedCellIndex = clickedCell.index;
    selectedVehicleOffset = 0;
    renderTooltipForSelection?.();
  });

  tooltipPrev.addEventListener("click", () => {
    if (selectedCellIndex === null || isContentVisible) {
      return;
    }

    const total = getVehiclesInCell(selectedCellIndex).length;
    if (total <= 1) {
      return;
    }

    selectedVehicleOffset = wrapIndex(selectedVehicleOffset - 1, total);
    renderTooltipForSelection?.();
  });

  tooltipNext.addEventListener("click", () => {
    if (selectedCellIndex === null || isContentVisible) {
      return;
    }

    const total = getVehiclesInCell(selectedCellIndex).length;
    if (total <= 1) {
      return;
    }

    selectedVehicleOffset = wrapIndex(selectedVehicleOffset + 1, total);
    renderTooltipForSelection?.();
  });

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
      clearSelection();
      hideHoverOutline();
      return;
    }

    renderer.resize(window.innerWidth, window.innerHeight);
    hideHoverOutline();

    if (selectedCellIndex !== null && !isContentVisible) {
      renderTooltipForSelection?.();
    }
  });
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", () => {
    pollingLoop.stop();
    renderer.stop();
  });
}

bootstrap();
