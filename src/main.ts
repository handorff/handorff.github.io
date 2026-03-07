import {
  FALLBACK_COLOR_HEX,
  GRID_CONFIG,
  OCCUPIED_CELL_ALPHA
} from "./config";
import {
  calculateRenderGridDimensions,
  buildCellStateMap,
  buildSelectedVehicleRgbaBuffer,
  buildRgbaBuffer,
  calculateGridDimensions,
  latLonToCell
} from "./grid";
import { fetchRoutes, fetchStopsByIds, fetchTripsByIds, fetchVehicles } from "./mbtaApi";
import { createPollingLoop } from "./polling";
import { GridRenderer } from "./renderer";
import { rasterizeShapeToCellIndices } from "./shapeGrid";
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
const DIMMED_OCCUPIED_CELL_ALPHA = 0.18;
const SHAPE_CELL_ALPHA = 0.76;
const SELECTED_CELL_ALPHA = 0.94;

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
  const selectedOutline = requireHtmlElement("#grid-selected-outline");
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
  selectedOutline.setAttribute("data-visible", "false");
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
  let selectedVehicleId: string | null = null;
  const shapeCellCache = new Map<string, { polyline: string; cellIndices: Set<number> }>();
  let renderTooltipForSelection: (() => void) | null = null;
  let updateSelectionVisualization: (() => void) | null = null;

  const tooltipMetadata = createTooltipMetadataStore({
    fetchStopsByIds,
    fetchTripsByIds,
    onDataChanged: () => {
      if (selectedVehicleId !== null && !isContentVisible) {
        renderer.setState(computeBuffer(latestVehicles));
        updateSelectionVisualization?.();
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

  const normalizeId = (id: string | null): string | null => {
    if (!id) {
      return null;
    }

    const trimmed = id.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const hideHoverOutline = (): void => {
    hoverOutline.setAttribute("data-visible", "false");
  };

  const hideSelectedOutline = (): void => {
    selectedOutline.setAttribute("data-visible", "false");
  };

  const hideTooltip = (): void => {
    tooltip.setAttribute("data-open", "false");
    tooltip.hidden = true;
  };

  const getVehiclePlacement = (vehicle: Vehicle) =>
    latLonToCell(
      GRID_CONFIG.bounds,
      baseDims,
      vehicle.latitude,
      vehicle.longitude,
      renderDims
    );

  const getSelectedVehicle = (vehicles: Vehicle[] = latestVehicles): Vehicle | null => {
    if (!selectedVehicleId) {
      return null;
    }

    return vehicles.find((vehicle) => vehicle.id === selectedVehicleId) ?? null;
  };

  const getRouteColorHex = (routeId: string | null): string =>
    routeId ? routesById.get(routeId)?.colorHex ?? FALLBACK_COLOR_HEX : FALLBACK_COLOR_HEX;

  const clearSelection = (rerender: boolean = true): void => {
    selectedVehicleId = null;
    hideTooltip();
    hideSelectedOutline();
    if (rerender && !isContentVisible) {
      renderer.setState(computeBuffer(latestVehicles));
    }
  };

  const getVehiclesInCell = (cellIndex: number, vehicles: Vehicle[] = latestVehicles): Vehicle[] => {
    const inCell: Vehicle[] = [];

    for (const vehicle of vehicles) {
      const placement = getVehiclePlacement(vehicle);

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

  const updateSelectedOutline = (cellIndex: number): void => {
    const row = Math.floor(cellIndex / renderDims.cols);
    const col = cellIndex % renderDims.cols;
    if (row < 0 || row >= renderDims.rows || col < 0 || col >= renderDims.cols) {
      hideSelectedOutline();
      return;
    }

    const cellRect = renderer.getCellRect(row, col);
    selectedOutline.style.left = `${cellRect.left}px`;
    selectedOutline.style.top = `${cellRect.top}px`;
    selectedOutline.style.width = `${cellRect.width}px`;
    selectedOutline.style.height = `${cellRect.height}px`;
    selectedOutline.setAttribute("data-visible", "true");
  };

  const getShapeCellIndicesForVehicle = (vehicle: Vehicle): Set<number> => {
    const tripId = normalizeId(vehicle.relatedTripId);
    if (!tripId) {
      return new Set<number>();
    }

    const polyline = tooltipMetadata.getShapePolyline(vehicle);
    if (!polyline) {
      return new Set<number>();
    }

    const cacheKey = `${tripId}:${renderDims.rows}x${renderDims.cols}`;
    const cached = shapeCellCache.get(cacheKey);
    if (cached && cached.polyline === polyline) {
      return cached.cellIndices;
    }

    const cellIndices = rasterizeShapeToCellIndices(
      polyline,
      GRID_CONFIG.bounds,
      baseDims,
      renderDims
    );
    shapeCellCache.set(cacheKey, { polyline, cellIndices });
    return cellIndices;
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

    const selectedVehicle = !isContentVisible ? getSelectedVehicle(vehicles) : null;
    if (!selectedVehicle) {
      return buildRgbaBuffer(renderDims.cellCount, stateByCell, OCCUPIED_CELL_ALPHA);
    }

    const selectedPlacement = getVehiclePlacement(selectedVehicle);
    if (!selectedPlacement) {
      return buildRgbaBuffer(renderDims.cellCount, stateByCell, OCCUPIED_CELL_ALPHA);
    }

    const routeColorHex = getRouteColorHex(selectedVehicle.routeId);
    const shapeCellIndices = getShapeCellIndicesForVehicle(selectedVehicle);
    return buildSelectedVehicleRgbaBuffer(renderDims.cellCount, stateByCell, {
      dimmedOccupiedAlpha: DIMMED_OCCUPIED_CELL_ALPHA,
      shapeCellIndices,
      shapeColorHex: routeColorHex,
      shapeAlpha: SHAPE_CELL_ALPHA,
      selectedCellIndex: selectedPlacement.index,
      selectedColorHex: routeColorHex,
      selectedAlpha: SELECTED_CELL_ALPHA
    });
  };

  const prefetchSelectedVehicleMetadata = (vehicle: Vehicle | null): void => {
    if (!vehicle || isContentVisible) {
      return;
    }

    void tooltipMetadata.prefetchFromVehicles([vehicle]).catch((error) => {
      console.error("Unable to prefetch tooltip metadata.", error);
    });
  };

  updateSelectionVisualization = (): void => {
    if (isContentVisible || !selectedVehicleId) {
      hideSelectedOutline();
      return;
    }

    const selectedVehicle = getSelectedVehicle();
    if (!selectedVehicle) {
      clearSelection();
      return;
    }

    const selectedPlacement = getVehiclePlacement(selectedVehicle);
    if (!selectedPlacement) {
      clearSelection();
      return;
    }

    updateSelectedOutline(selectedPlacement.index);
  };

  renderTooltipForSelection = (): void => {
    if (!selectedVehicleId || isContentVisible) {
      hideTooltip();
      return;
    }

    const selectedVehicle = getSelectedVehicle();
    if (!selectedVehicle) {
      clearSelection();
      return;
    }

    const selectedPlacement = getVehiclePlacement(selectedVehicle);
    if (!selectedPlacement) {
      clearSelection();
      return;
    }

    const vehiclesInCell = getVehiclesInCell(selectedPlacement.index);
    if (vehiclesInCell.length === 0) {
      clearSelection();
      return;
    }

    let selectedVehicleOffset = vehiclesInCell.findIndex((vehicle) => vehicle.id === selectedVehicleId);
    if (selectedVehicleOffset < 0) {
      selectedVehicleOffset = 0;
      selectedVehicleId = vehiclesInCell[0].id;
    }

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
    positionTooltipForCell(selectedPlacement.index);
  };

  const refreshVehicles = async (): Promise<void> => {
    try {
      const vehicles = await fetchVehicles();
      latestVehicles = vehicles;
      if (selectedVehicleId) {
        const selectedVehicle = getSelectedVehicle(vehicles);
        if (!selectedVehicle || !getVehiclePlacement(selectedVehicle)) {
          clearSelection(false);
        }
      }

      const nextBuffer = computeBuffer(vehicles);
      renderer.setState(nextBuffer);

      if (!isContentVisible) {
        void tooltipMetadata.prefetchFromVehicles(vehicles).catch((error) => {
          console.error("Unable to prefetch tooltip metadata.", error);
        });
      }

      if (!isContentVisible && selectedVehicleId) {
        updateSelectionVisualization?.();
        renderTooltipForSelection?.();
      }
    } catch (error) {
      console.error("Unable to refresh MBTA vehicles. Keeping current frame.", error);
    }
  };

  const pollingLoop = createPollingLoop({
    intervalMs: GRID_CONFIG.pollIntervalMs,
    task: refreshVehicles
  });

  const setContentVisibility = (visible: boolean): void => {
    isContentVisible = visible;
    contentVisibilityToggle.checked = visible;
    tooltipMetadata.setHiddenModeEnabled(!isContentVisible);
    setContentLayerVisible(content, contentOverlay, isContentVisible);

    if (isContentVisible) {
      clearSelection();
      hideHoverOutline();
      return;
    }

    renderer.setState(computeBuffer(latestVehicles));
    void tooltipMetadata.prefetchFromVehicles(latestVehicles).catch((error) => {
      console.error("Unable to prefetch tooltip metadata.", error);
    });
  };

  const onVisibilityChange = (): void => {
    pollingLoop.setPaused(document.hidden);
  };

  contentVisibilityToggle.addEventListener("change", () => {
    setContentVisibility(contentVisibilityToggle.checked);
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
      setContentVisibility(false);
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

    selectedVehicleId = vehiclesInCell[0].id;
    prefetchSelectedVehicleMetadata(vehiclesInCell[0]);
    renderer.setState(computeBuffer(latestVehicles));
    updateSelectionVisualization?.();
    renderTooltipForSelection?.();
  });

  tooltipPrev.addEventListener("click", () => {
    if (!selectedVehicleId || isContentVisible) {
      return;
    }

    const selectedVehicle = getSelectedVehicle();
    if (!selectedVehicle) {
      clearSelection();
      return;
    }

    const placement = getVehiclePlacement(selectedVehicle);
    if (!placement) {
      clearSelection();
      return;
    }

    const vehiclesInCell = getVehiclesInCell(placement.index);
    const total = vehiclesInCell.length;
    if (total <= 1) {
      return;
    }

    const currentIndex = Math.max(0, vehiclesInCell.findIndex((vehicle) => vehicle.id === selectedVehicleId));
    const previousIndex = wrapIndex(currentIndex - 1, total);
    selectedVehicleId = vehiclesInCell[previousIndex].id;
    prefetchSelectedVehicleMetadata(vehiclesInCell[previousIndex]);
    renderer.setState(computeBuffer(latestVehicles));
    updateSelectionVisualization?.();
    renderTooltipForSelection?.();
  });

  tooltipNext.addEventListener("click", () => {
    if (!selectedVehicleId || isContentVisible) {
      return;
    }

    const selectedVehicle = getSelectedVehicle();
    if (!selectedVehicle) {
      clearSelection();
      return;
    }

    const placement = getVehiclePlacement(selectedVehicle);
    if (!placement) {
      clearSelection();
      return;
    }

    const vehiclesInCell = getVehiclesInCell(placement.index);
    const total = vehiclesInCell.length;
    if (total <= 1) {
      return;
    }

    const currentIndex = Math.max(0, vehiclesInCell.findIndex((vehicle) => vehicle.id === selectedVehicleId));
    const nextIndex = wrapIndex(currentIndex + 1, total);
    selectedVehicleId = vehiclesInCell[nextIndex].id;
    prefetchSelectedVehicleMetadata(vehiclesInCell[nextIndex]);
    renderer.setState(computeBuffer(latestVehicles));
    updateSelectionVisualization?.();
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
      shapeCellCache.clear();
      renderer.stop();
      renderer = createRenderer();
      renderer.setState(computeBuffer(latestVehicles));
      hideHoverOutline();
      updateSelectionVisualization?.();
      renderTooltipForSelection?.();
      return;
    }

    renderer.resize(window.innerWidth, window.innerHeight);
    hideHoverOutline();
    updateSelectionVisualization?.();

    if (selectedVehicleId !== null && !isContentVisible) {
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
