import {
  FALLBACK_COLOR_HEX,
  GRID_CONFIG,
  OCCUPIED_CELL_ALPHA,
  SERVICE_AREA_BOUNDS
} from "./config";
import {
  DEBUG_SOURCE_KEYS,
  type DebugSourceKey,
  formatDebugTimestamp,
  isDebugModeEnabled
} from "./debug";
import {
  calculateRenderGridDimensions,
  calculateCoverageGridDimensions,
  buildCellStateMap,
  buildSelectedVehicleRgbaBuffer,
  buildRgbaBuffer,
  calculateGridDimensions,
  latLonToCell
} from "./grid";
import { fetchStopsByIds, fetchTripsByIds, fetchVehicleSnapshot } from "./mbtaApi";
import { bindMapNavigation } from "./mapNavigation";
import { bindNavigation } from "./navigation";
import { bindPageLifecycle, createPollingLoop } from "./polling";
import { GridRenderer } from "./renderer";
import { rasterizeShapeToCellIndices } from "./shapeGrid";
import { createShapePrefetcher } from "./shapePrefetch";
import type { RouteMeta, Vehicle } from "./types";
import {
  applyTheme,
  createThemeState,
  getThemeGridLineColor,
  setContentLayerVisible
} from "./ui";
import {
  formatVehicleStatusLabel,
  formatVehicleTitle,
  wrapIndex
} from "./vehicleTooltip";
import { createTooltipMetadataStore } from "./tooltipMetadata";
import "./styles.css";

const DIMMED_OCCUPIED_CELL_ALPHA = 0.18;
const SHAPE_CELL_ALPHA = 0.76;
const SELECTED_CELL_ALPHA = 0.94;
const SELECTION_TRANSITION_MS = 180;

function requireCanvas(selector: string): HTMLCanvasElement {
  const element = document.querySelector(selector);
  if (!element || !(element instanceof HTMLCanvasElement)) {
    throw new Error(`Missing required canvas element: ${selector}`);
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

function sameDims(
  a: { rows: number; cols: number },
  b: { rows: number; cols: number }
): boolean {
  return a.rows === b.rows && a.cols === b.cols;
}

function createEmptyDebugSourceMap(): Record<DebugSourceKey, Date | null> {
  return {
    vehicles: null,
    routes: null,
    stops: null,
    trips: null
  };
}

function bootstrap(): void {
  const debugModeEnabled = isDebugModeEnabled(window.location.search);
  const canvas = requireCanvas("#grid-canvas");
  const contentOverlay = requireHtmlElement("#content-overlay");
  const content = requireHtmlElement("#site-content");
  const header = requireHtmlElement("#site-header");
  const contentVisibilityToggle = requireButton("#toggle-content-visibility");
  const darkModeToggle = requireButton("#toggle-dark-mode");
  const hoverOutline = requireHtmlElement("#grid-hover-outline");
  const selectedOutline = requireHtmlElement("#grid-selected-outline");
  const tooltip = requireHtmlElement("#vehicle-tooltip");
  const tooltipTitle = requireHtmlElement("#vehicle-tooltip-title");
  const tooltipStatus = requireHtmlElement("#vehicle-tooltip-status");
  const tooltipStop = requireHtmlElement("#vehicle-tooltip-stop");
  const tooltipIndex = requireHtmlElement("#vehicle-tooltip-index");
  const tooltipDebug = requireHtmlElement("#vehicle-tooltip-debug");
  const tooltipDebugRouteId = requireHtmlElement("#vehicle-tooltip-debug-route-id");
  const tooltipDebugTripId = requireHtmlElement("#vehicle-tooltip-debug-trip-id");
  const tooltipDebugStopId = requireHtmlElement("#vehicle-tooltip-debug-stop-id");
  const tooltipPrev = requireButton("#vehicle-tooltip-prev");
  const tooltipNext = requireButton("#vehicle-tooltip-next");
  const debugFooter = requireHtmlElement("#debug-footer");
  const debugFooterTimestampBySource: Record<DebugSourceKey, HTMLElement> = {
    vehicles: requireHtmlElement("#debug-footer-vehicles-updated"),
    routes: requireHtmlElement("#debug-footer-routes-updated"),
    stops: requireHtmlElement("#debug-footer-stops-updated"),
    trips: requireHtmlElement("#debug-footer-trips-updated")
  };
  const themeState = createThemeState("light");
  const finePointerMediaQuery =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(hover: hover) and (pointer: fine)")
      : null;

  applyTheme(themeState.getTheme());
  contentVisibilityToggle.setAttribute("aria-pressed", "true");
  darkModeToggle.setAttribute("aria-pressed", "false");
  setContentLayerVisible(content, contentOverlay, true);
  hoverOutline.setAttribute("data-visible", "false");
  selectedOutline.setAttribute("data-visible", "false");
  tooltip.setAttribute("data-open", "false");
  tooltip.hidden = true;
  tooltipDebug.hidden = !debugModeEnabled;
  debugFooter.hidden = !debugModeEnabled;

  const baseDims = calculateGridDimensions(GRID_CONFIG);
  const coverageDims = calculateCoverageGridDimensions(GRID_CONFIG.bounds, baseDims, SERVICE_AREA_BOUNDS);
  let renderDims = calculateRenderGridDimensions(
    coverageDims,
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
  const routesById = new Map<string, RouteMeta>();
  let latestVehicles: Vehicle[] = [];
  let isContentVisible = true;
  const updateContentMask = (): void => {
    const measureText = (element: HTMLElement) => {
      const rects = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        for (const rect of range.getClientRects()) {
          rects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
        }
      }
      return rects;
    };
    const headerRects = measureText(header);
    for (const input of header.querySelectorAll("input")) {
      const rect = input.getBoundingClientRect();
      headerRects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    }
    renderer.setContentRects(measureText(content), headerRects);
    renderer.setContentMaskVisible(isContentVisible);
  };
  const contentObserver = new ResizeObserver(updateContentMask);
  contentObserver.observe(content);
  contentObserver.observe(header);
  contentOverlay.addEventListener("scroll", updateContentMask, { passive: true });
  void document.fonts.ready.then(updateContentMask);
  let selectedVehicleId: string | null = null;
  const shapeCellCache = new Map<string, { polyline: string; cellIndices: Set<number> }>();
  const debugSourceUpdatedAt = createEmptyDebugSourceMap();
  let renderTooltipForSelection: (() => void) | null = null;
  let updateSelectionVisualization: (() => void) | null = null;

  const renderDebugFooter = (): void => {
    if (!debugModeEnabled) {
      return;
    }

    for (const sourceKey of DEBUG_SOURCE_KEYS) {
      debugFooterTimestampBySource[sourceKey].textContent = formatDebugTimestamp(
        debugSourceUpdatedAt[sourceKey]
      );
    }
  };

  const markDebugSourceUpdated = (sourceKey: DebugSourceKey): void => {
    debugSourceUpdatedAt[sourceKey] = new Date();
    renderDebugFooter();
  };

  const tooltipMetadata = createTooltipMetadataStore({
    fetchStopsByIds: async (stopIds) => {
      const result = await fetchStopsByIds(stopIds);
      markDebugSourceUpdated("stops");
      return result;
    },
    fetchTripsByIds: async (tripIds) => {
      const result = await fetchTripsByIds(tripIds);
      markDebugSourceUpdated("trips");
      return result;
    },
    onDataChanged: (tripId) => {
      if (selectedVehicleId !== null && !isContentVisible &&
          (!tripId || getSelectedVehicle()?.relatedTripId === tripId)) {
        renderSelectionState();
        updateSelectionVisualization?.();
        renderTooltipForSelection?.();
      }
    }
  });

  const shapePrefetcher = createShapePrefetcher(
    (vehicle) => tooltipMetadata.ensureShapeLoaded(vehicle),
    (error) => console.error("Unable to prefetch route shape.", error)
  );

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

  const formatDebugId = (id: string | null): string => normalizeId(id) ?? "Unknown";

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
      renderSelectionState();
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

  const renderSelectionState = (): void => {
    renderer.setState(computeBuffer(latestVehicles), performance.now(), SELECTION_TRANSITION_MS);
  };

  const prefetchSelectedVehicleMetadata = (vehicle: Vehicle | null): void => {
    shapePrefetcher.cancel();
    if (!vehicle || isContentVisible) {
      return;
    }

    void Promise.all([
      tooltipMetadata.prefetchFromVehicles([vehicle]),
      tooltipMetadata.ensureShapeLoaded(vehicle)
    ]).catch((error) => {
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
    if (debugModeEnabled) {
      tooltipDebugRouteId.textContent = formatDebugId(vehicle.routeId);
      tooltipDebugTripId.textContent = formatDebugId(vehicle.relatedTripId);
      tooltipDebugStopId.textContent = formatDebugId(vehicle.relatedStopId);
    }

    const disablePagination = vehiclesInCell.length <= 1;
    tooltipPrev.disabled = disablePagination;
    tooltipNext.disabled = disablePagination;

    tooltip.hidden = false;
    tooltip.setAttribute("data-open", "true");
  };

  const refreshVehicles = async (): Promise<void> => {
    try {
      const snapshot = await fetchVehicleSnapshot();
      markDebugSourceUpdated("vehicles");
      for (const route of snapshot.routes) routesById.set(route.id, route);
      tooltipMetadata.seed(snapshot.stops, snapshot.trips);
      if (snapshot.routes.length > 0) markDebugSourceUpdated("routes");
      if (snapshot.stops.size > 0) markDebugSourceUpdated("stops");
      if (snapshot.trips.size > 0) markDebugSourceUpdated("trips");
      // Only trips actually included by the API are valid for rendering.
      const vehicles = tooltipMetadata.filterRenderableVehicles(snapshot.vehicles);
      latestVehicles = vehicles;
      if (selectedVehicleId) {
        const selectedVehicle = getSelectedVehicle(vehicles);
        if (!selectedVehicle || !getVehiclePlacement(selectedVehicle)) {
          clearSelection(false);
        }
      }

      const nextBuffer = computeBuffer(vehicles);
      renderer.setState(nextBuffer);

      if (!isContentVisible && selectedVehicleId) {
        updateSelectionVisualization?.();
        renderTooltipForSelection?.();
        prefetchSelectedVehicleMetadata(getSelectedVehicle());
      }
    } catch (error) {
      console.error("Unable to refresh MBTA vehicles. Keeping current frame.", error);
    }
  };

  const pollingLoop = createPollingLoop({
    intervalMs: GRID_CONFIG.pollIntervalMs,
    task: refreshVehicles
  });

  renderDebugFooter();

  const mapNavigation = bindMapNavigation({
    canvas,
    controls: requireHtmlElement("#map-controls"),
    zoomIn: requireButton("#map-zoom-in"),
    zoomOut: requireButton("#map-zoom-out"),
    reset: requireButton("#map-reset"),
    getRenderer: () => renderer,
    onGestureStart: () => {
      shapePrefetcher.cancel();
      hideHoverOutline();
    },
    onViewChanged: () => {
      hideHoverOutline();
      updateSelectionVisualization?.();
    }
  });
  mapNavigation.setEnabled(false);

  const setContentVisibility = (visible: boolean): void => {
    isContentVisible = visible;
    mapNavigation.setEnabled(!visible);
    shapePrefetcher.cancel();
    contentVisibilityToggle.setAttribute("aria-pressed", String(visible));
    contentVisibilityToggle.title = visible ? "Hide content" : "Show content";
    tooltipMetadata.setHiddenModeEnabled(!isContentVisible);
    setContentLayerVisible(content, contentOverlay, isContentVisible);
    renderer.setContentMaskVisible(isContentVisible);

    if (isContentVisible) {
      clearSelection();
      renderer.setState(computeBuffer(latestVehicles));
      hideHoverOutline();
      return;
    }

    renderer.setState(computeBuffer(latestVehicles));
  };

  bindNavigation({
    header,
    content,
    overlay: contentOverlay,
    onNavigate: () => {
      setContentVisibility(true);
      updateContentMask();
    }
  });

  const onVisibilityChange = (): void => {
    if (document.hidden) shapePrefetcher.cancel();
    pollingLoop.setPaused(document.hidden);
  };

  contentVisibilityToggle.addEventListener("click", () => {
    setContentVisibility(!isContentVisible);
  });

  darkModeToggle.addEventListener("click", () => {
    const nextTheme = themeState.setDarkModeEnabled(themeState.getTheme() !== "dark");
    darkModeToggle.setAttribute("aria-pressed", String(nextTheme === "dark"));
    darkModeToggle.title = nextTheme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    applyTheme(nextTheme);
    renderer.setGridLineColor(getThemeGridLineColor(nextTheme));
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!canShowHoverOutline() || event.buttons !== 0) {
      shapePrefetcher.cancel();
      hideHoverOutline();
      return;
    }

    const hoveredCell = renderer.getCellFromViewportPoint(event.clientX, event.clientY);
    if (!hoveredCell) {
      shapePrefetcher.cancel();
      hideHoverOutline();
      return;
    }

    updateHoverOutline(hoveredCell.index);
    shapePrefetcher.target(getVehiclesInCell(hoveredCell.index)[0] ?? null);
  });

  canvas.addEventListener("pointerleave", () => {
    shapePrefetcher.cancel();
    hideHoverOutline();
  });

  canvas.addEventListener("click", (event) => {
    shapePrefetcher.cancel();
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
    renderSelectionState();
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
    renderSelectionState();
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
    renderSelectionState();
    updateSelectionVisualization?.();
    renderTooltipForSelection?.();
  });

  for (const [button, offset] of [[tooltipPrev, -1], [tooltipNext, 1]] as const) {
    const prefetchAdjacentVehicle = (): void => {
      if (isContentVisible || button.disabled) return;
      const selected = getSelectedVehicle();
      const placement = selected && getVehiclePlacement(selected);
      if (!placement) return;
      const vehicles = getVehiclesInCell(placement.index);
      const index = vehicles.findIndex((vehicle) => vehicle.id === selectedVehicleId);
      shapePrefetcher.target(vehicles[wrapIndex(index + offset, vehicles.length)] ?? null);
    };
    button.addEventListener("focus", prefetchAdjacentVehicle);
    button.addEventListener("pointerenter", prefetchAdjacentVehicle);
    button.addEventListener("blur", () => shapePrefetcher.cancel());
    button.addEventListener("pointerleave", () => shapePrefetcher.cancel());
  }

  onVisibilityChange();
  pollingLoop.start();

  window.addEventListener("resize", () => {
    shapePrefetcher.cancel();
    const nextRenderDims = calculateRenderGridDimensions(
      coverageDims,
      window.innerWidth,
      window.innerHeight,
      GRID_CONFIG.cellSizePx
    );

    if (!sameDims(renderDims, nextRenderDims)) {
      renderDims = nextRenderDims;
      shapeCellCache.clear();
      const view = renderer.getView();
      renderer.stop();
      renderer = createRenderer();
      renderer.setView(view);
      updateContentMask();
      renderer.setState(computeBuffer(latestVehicles));
      hideHoverOutline();
      updateSelectionVisualization?.();
      renderTooltipForSelection?.();
      return;
    }

    renderer.resize(window.innerWidth, window.innerHeight);
    updateContentMask();
    hideHoverOutline();
    updateSelectionVisualization?.();

    if (selectedVehicleId !== null && !isContentVisible) {
      renderTooltipForSelection?.();
    }
  });
  document.addEventListener("visibilitychange", onVisibilityChange);
  bindPageLifecycle(window, () => {
    shapePrefetcher.cancel();
    pollingLoop.stop();
    contentObserver.disconnect();
    renderer.stop();
  }, () => {
    contentObserver.observe(content);
    contentObserver.observe(header);
    updateContentMask();
    renderer.start();
    onVisibilityChange();
    pollingLoop.start();
  });
}

bootstrap();
