import { GridRenderer, MAX_MAP_ZOOM, MIN_MAP_ZOOM } from "./renderer";

/** Keep gestures on the canvas so header and content controls retain their native behavior. */
export function bindMapNavigation(options: {
  canvas: HTMLCanvasElement;
  controls: HTMLElement;
  zoomIn: HTMLButtonElement;
  zoomOut: HTMLButtonElement;
  reset: HTMLButtonElement;
  getRenderer: () => GridRenderer;
  onViewChanged: () => void;
  onGestureStart: () => void;
  prefersReducedMotion?: () => boolean;
}): { setEnabled: (enabled: boolean) => void } {
  const { canvas, controls, zoomIn, zoomOut, reset, getRenderer, onViewChanged, onGestureStart } = options;
  const pointers = new Map<number, { x: number; y: number }>();
  let enabled = false;
  let dragged = false;
  let origin = { x: 0, y: 0 };

  const update = (): void => {
    const { zoom } = getRenderer().getView();
    zoomIn.disabled = zoom >= MAX_MAP_ZOOM;
    zoomOut.disabled = zoom <= MIN_MAP_ZOOM;
    onViewChanged();
  };
  const zoom = (factor: number): void => {
    if (!enabled) return;
    onGestureStart();
    getRenderer().zoomAt(factor);
    update();
  };
  zoomIn.addEventListener("click", () => zoom(1.25));
  zoomOut.addEventListener("click", () => zoom(1 / 1.25));
  reset.addEventListener("click", () => {
    if (!enabled) return;
    onGestureStart();
    getRenderer().setView({ zoom: 1, panX: 0, panY: 0 });
    update();
  });

  canvas.addEventListener("wheel", (event) => {
    if (!enabled) return;
    event.preventDefault();
    onGestureStart();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
    getRenderer().zoomAt(Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.002), event.clientX, event.clientY);
    update();
  }, { passive: false });

  canvas.addEventListener("pointerdown", (event) => {
    if (!enabled || event.button !== 0) return;
    if (pointers.size === 0) {
      dragged = false;
      origin = { x: event.clientX, y: event.clientY };
    } else {
      dragged = true;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    canvas.setPointerCapture(event.pointerId);
    onGestureStart();
  });

  canvas.addEventListener("pointermove", (event) => {
    const previous = pointers.get(event.pointerId);
    if (!enabled || !previous) return;
    const next = { x: event.clientX, y: event.clientY };
    const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)?.[1];
    if (!dragged && Math.hypot(next.x - origin.x, next.y - origin.y) < 5) return;
    dragged = true;
    canvas.dataset.dragging = "true";
    if (other) {
      const oldCenter = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 };
      const newCenter = { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 };
      const oldDistance = Math.hypot(previous.x - other.x, previous.y - other.y);
      const newDistance = Math.hypot(next.x - other.x, next.y - other.y);
      if (oldDistance > 0 && newDistance > 0) {
        getRenderer().zoomAt(newDistance / oldDistance, oldCenter.x, oldCenter.y);
      }
      getRenderer().panBy(newCenter.x - oldCenter.x, newCenter.y - oldCenter.y);
    } else {
      getRenderer().panBy(next.x - previous.x, next.y - previous.y);
    }
    pointers.set(event.pointerId, next);
    update();
  });

  const endPointer = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
    if (pointers.size === 0) canvas.dataset.dragging = "false";
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", (event) => {
    dragged = true;
    endPointer(event);
  });
  canvas.addEventListener("lostpointercapture", endPointer);
  // A drag or pinch must never select the cell under its release point.
  canvas.addEventListener("click", (event) => {
    if (enabled && dragged) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  }, { capture: true });

  return {
    setEnabled: (nextEnabled) => {
      const wasEnabled = enabled;
      enabled = nextEnabled;
      controls.hidden = !enabled;
      canvas.dataset.interactive = String(enabled);
      canvas.dataset.dragging = "false";
      for (const pointerId of pointers.keys()) {
        if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
      }
      pointers.clear();
      dragged = false;
      if (enabled) {
        getRenderer().cancelViewAnimation();
      } else if (wasEnabled) {
        getRenderer().animateView({ zoom: 1, panX: 0, panY: 0 }, options.prefersReducedMotion?.() ? 0 : 600);
      } else {
        getRenderer().setView({ zoom: 1, panX: 0, panY: 0 });
      }
      update();
    }
  };
}
