interface RendererOptions {
  canvas: HTMLCanvasElement;
  rows: number;
  cols: number;
  cellSizePx: number;
  cellGapPx: number;
  transitionMs: number;
  gridLineColor?: string;
}

export interface CellCoordinates {
  row: number;
  col: number;
  index: number;
}

export interface CellRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MapView {
  zoom: number;
  panX: number;
  panY: number;
}

export const MIN_MAP_ZOOM = 0.025;
export const MAX_MAP_ZOOM = 4;

interface GridMetrics {
  pitch: number;
  fillSize: number;
  inset: number;
  gridWidthPx: number;
  gridHeightPx: number;
  offsetX: number;
  offsetY: number;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

const FADE_IN_START_CHANNEL = 255;
const DEFAULT_GRID_LINE_COLOR = "rgba(130, 138, 145, 0.16)";
const GRID_LINE_WIDTH_PX = 0.8;

export function interpolateBuffers(
  from: Float32Array,
  to: Float32Array,
  progress: number,
  out: Float32Array = new Float32Array(from.length)
): Float32Array {
  const t = clamp01(progress);
  for (let i = 0; i < from.length; i += 4) {
    const fromAlpha = from[i + 3];
    const toAlpha = to[i + 3];
    const isFadingInFromEmpty = fromAlpha <= 0.001 && toAlpha > 0.001;

    const startRed = isFadingInFromEmpty ? FADE_IN_START_CHANNEL : from[i];
    const startGreen = isFadingInFromEmpty ? FADE_IN_START_CHANNEL : from[i + 1];
    const startBlue = isFadingInFromEmpty ? FADE_IN_START_CHANNEL : from[i + 2];

    out[i] = startRed + (to[i] - startRed) * t;
    out[i + 1] = startGreen + (to[i + 1] - startGreen) * t;
    out[i + 2] = startBlue + (to[i + 2] - startBlue) * t;
    out[i + 3] = fromAlpha + (toAlpha - fromAlpha) * t;
  }
  return out;
}

export class GridRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly rows: number;
  private readonly cols: number;
  private readonly cellSizePx: number;
  private readonly cellGapPx: number;
  private readonly transitionMs: number;
  private activeTransitionMs: number;
  private readonly fromBuffer: Float32Array;
  private readonly toBuffer: Float32Array;
  private readonly frameBuffer: Float32Array;
  private gridLineColor: string;
  private view: MapView = { zoom: 1, panX: 0, panY: 0 };
  private viewTransition: { from: MapView; to: MapView; startMs: number; durationMs: number } | null = null;
  private textRects: CellRect[] = [];
  private persistentRects: CellRect[] = [];
  private dpr = 1;
  private viewportWidthPx = 0;
  private viewportHeightPx = 0;
  private transitionStartMs = 0;
  private transitionComplete = true;
  private rafId: number | null = null;
  private contentMask: { left: number; top: number; opacity: number; persistentOpacity: number }[] = [];
  private contentMaskVisible = true;
  private contentMaskStrength = 1;

  public constructor(options: RendererOptions) {
    const context = options.canvas.getContext("2d");
    if (!context) {
      throw new Error("Unable to initialize Canvas 2D context.");
    }

    this.ctx = context;
    this.rows = options.rows;
    this.cols = options.cols;
    this.cellSizePx = options.cellSizePx;
    this.cellGapPx = options.cellGapPx;
    this.transitionMs = options.transitionMs;
    this.activeTransitionMs = options.transitionMs;
    this.gridLineColor = options.gridLineColor ?? DEFAULT_GRID_LINE_COLOR;

    const channelCount = this.rows * this.cols * 4;
    this.fromBuffer = new Float32Array(channelCount);
    this.toBuffer = new Float32Array(channelCount);
    this.frameBuffer = new Float32Array(channelCount);
  }

  public resize(widthPx: number = window.innerWidth, heightPx: number = window.innerHeight): void {
    this.viewportWidthPx = widthPx;
    this.viewportHeightPx = heightPx;
    const devicePixelRatio =
      typeof window === "undefined" ? 1 : (window.devicePixelRatio || 1);
    this.dpr = Math.min(devicePixelRatio, 2);

    this.ctx.canvas.width = Math.max(1, Math.floor(widthPx * this.dpr));
    this.ctx.canvas.height = Math.max(1, Math.floor(heightPx * this.dpr));
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  public setState(
    nextBuffer: Float32Array,
    nowMs: number = performance.now(),
    transitionMs: number = this.transitionMs
  ): void {
    if (nextBuffer.length !== this.toBuffer.length) {
      throw new Error("Incoming state buffer does not match renderer grid size.");
    }

    this.fromBuffer.set(this.frameBuffer);
    this.toBuffer.set(nextBuffer);
    this.transitionStartMs = nowMs;
    this.transitionComplete = false;
    this.activeTransitionMs = transitionMs;
  }

  public start(): void {
    if (this.rafId !== null) {
      return;
    }

    const drawLoop = (timestampMs: number): void => {
      this.draw(timestampMs);
      this.rafId = requestAnimationFrame(drawLoop);
    };

    this.rafId = requestAnimationFrame(drawLoop);
  }

  public stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  public setGridLineColor(color: string): void {
    this.gridLineColor = color;
  }

  public setContentMaskVisible(visible: boolean): void {
    this.contentMaskVisible = visible;
  }

  public getView(): MapView {
    return { ...this.view };
  }

  public setView(view: MapView): void {
    this.cancelViewAnimation();
    this.applyView(view);
  }

  public cancelViewAnimation(): void {
    this.viewTransition = null;
  }

  public animateView(view: MapView, durationMs: number, nowMs = performance.now()): void {
    if (durationMs <= 0) {
      this.setView(view);
      return;
    }
    this.viewTransition = {
      from: this.getView(),
      to: { ...view, zoom: Math.min(MAX_MAP_ZOOM, Math.max(MIN_MAP_ZOOM, view.zoom)) },
      startMs: nowMs,
      durationMs
    };
  }

  private applyView(view: MapView): void {
    this.view = { ...view, zoom: Math.min(MAX_MAP_ZOOM, Math.max(MIN_MAP_ZOOM, view.zoom)) };
    this.setContentRects(this.textRects, this.persistentRects);
  }

  public panBy(dx: number, dy: number): void {
    this.setView({ ...this.view, panX: this.view.panX + dx, panY: this.view.panY + dy });
  }

  public zoomAt(factor: number, x = this.viewportWidthPx / 2, y = this.viewportHeightPx / 2): void {
    const zoom = Math.min(MAX_MAP_ZOOM, Math.max(MIN_MAP_ZOOM, this.view.zoom * factor));
    const ratio = zoom / this.view.zoom;
    this.setView({
      zoom,
      panX: x - this.viewportWidthPx / 2 - (x - this.viewportWidthPx / 2 - this.view.panX) * ratio,
      panY: y - this.viewportHeightPx / 2 - (y - this.viewportHeightPx / 2 - this.view.panY) * ratio
    });
  }

  public setContentRects(rects: CellRect[], persistentRects: CellRect[] = []): void {
    this.textRects = rects;
    this.persistentRects = persistentRects;
    const metrics = this.getGridMetrics();
    this.contentMask = [];
    // Cache a cell-aligned fade around actual text lines, rather than the content box.
    const featherPx = 64;
    const visible = this.getVisibleCells(metrics);
    for (let row = visible.firstRow; row < visible.endRow; row += 1) {
      for (let col = visible.firstCol; col < visible.endCol; col += 1) {
        const left = metrics.offsetX + col * metrics.pitch;
        const top = metrics.offsetY + row * metrics.pitch;
        const x = left + metrics.pitch / 2;
        const y = top + metrics.pitch / 2;
        const opacityNear = (textRects: CellRect[]): number => {
          let opacity = 0;
          for (const rect of textRects) {
            const dx = Math.max(rect.left - x, 0, x - rect.left - rect.width);
            const dy = Math.max(rect.top - y, 0, y - rect.top - rect.height);
            const distance = Math.hypot(dx, dy);
            const t = clamp01((distance - metrics.pitch / 2) / featherPx);
            const fade = 1 - t * t * (3 - 2 * t);
            opacity = Math.max(opacity, fade * 0.94);
          }
          return opacity;
        };
        const opacity = opacityNear(rects);
        const persistentOpacity = opacityNear(persistentRects);
        if (Math.max(opacity, persistentOpacity) > 0.001) {
          this.contentMask.push({ left, top, opacity, persistentOpacity });
        }
      }
    }
  }

  public getCellFromViewportPoint(x: number, y: number): CellCoordinates | null {
    const metrics = this.getGridMetrics();

    if (
      x < metrics.offsetX ||
      y < metrics.offsetY ||
      x >= metrics.offsetX + metrics.gridWidthPx ||
      y >= metrics.offsetY + metrics.gridHeightPx
    ) {
      return null;
    }

    const col = Math.floor((x - metrics.offsetX) / metrics.pitch);
    const row = Math.floor((y - metrics.offsetY) / metrics.pitch);
    const index = row * this.cols + col;
    return { row, col, index };
  }

  public getCellRect(row: number, col: number): CellRect {
    if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) {
      throw new Error(`Cell out of range: row=${row}, col=${col}`);
    }

    const metrics = this.getGridMetrics();
    return {
      left: metrics.offsetX + col * metrics.pitch,
      top: metrics.offsetY + row * metrics.pitch,
      width: metrics.pitch,
      height: metrics.pitch
    };
  }

  private draw(nowMs: number): void {
    if (this.viewTransition) {
      const { from, to, startMs, durationMs } = this.viewTransition;
      const progress = clamp01((nowMs - startMs) / durationMs);
      const eased = progress * progress * (3 - 2 * progress);
      // Interpolate zoom proportionally for a steady change in perceived scale.
      this.applyView(progress >= 1 ? to : {
        zoom: from.zoom * Math.pow(to.zoom / from.zoom, eased),
        panX: from.panX + (to.panX - from.panX) * eased,
        panY: from.panY + (to.panY - from.panY) * eased
      });
      if (progress >= 1) this.viewTransition = null;
    }
    const progress = this.activeTransitionMs <= 0 ? 1 : (nowMs - this.transitionStartMs) / this.activeTransitionMs;
    if (!this.transitionComplete) {
      interpolateBuffers(this.fromBuffer, this.toBuffer, progress, this.frameBuffer);
      this.transitionComplete = progress >= 1;
    }
    this.drawFrame(this.frameBuffer);
  }

  private drawFrame(buffer: Float32Array): void {
    const metrics = this.getGridMetrics();

    this.ctx.clearRect(0, 0, this.viewportWidthPx, this.viewportHeightPx);
    this.drawGridLines(
      metrics.offsetX,
      metrics.offsetY,
      metrics.gridWidthPx,
      metrics.gridHeightPx,
      metrics.pitch
    );

    const visible = this.getVisibleCells(metrics);
    for (let row = visible.firstRow; row < visible.endRow; row += 1) {
      for (let col = visible.firstCol; col < visible.endCol; col += 1) {
        const index = row * this.cols + col;
        const offset = index * 4;
        const alpha = buffer[offset + 3];

        if (alpha <= 0.001) {
          continue;
        }

        this.ctx.fillStyle = `rgba(${Math.round(buffer[offset])}, ${Math.round(buffer[offset + 1])}, ${Math.round(buffer[offset + 2])}, ${alpha.toFixed(4)})`;
        this.ctx.fillRect(
          metrics.offsetX + col * metrics.pitch + metrics.inset,
          metrics.offsetY + row * metrics.pitch + metrics.inset,
          metrics.fillSize,
          metrics.fillSize
        );
      }
    }

    this.contentMaskStrength += ((this.contentMaskVisible ? 1 : 0) - this.contentMaskStrength) * 0.18;
    if (this.contentMask.length > 0) {
      this.ctx.save();
      this.ctx.globalCompositeOperation = "destination-out";
      for (const cell of this.contentMask) {
        if (Math.max(cell.opacity * this.contentMaskStrength, cell.persistentOpacity) <= 0.001) continue;
        this.ctx.fillStyle = `rgba(0, 0, 0, ${Math.max(cell.opacity * this.contentMaskStrength, cell.persistentOpacity)})`;
        this.ctx.fillRect(cell.left, cell.top, metrics.pitch, metrics.pitch);
      }
      this.ctx.restore();
    }
  }

  private getVisibleCells(metrics: GridMetrics) {
    return {
      firstRow: Math.max(0, Math.floor(-metrics.offsetY / metrics.pitch)),
      endRow: Math.min(this.rows, Math.ceil((this.viewportHeightPx - metrics.offsetY) / metrics.pitch)),
      firstCol: Math.max(0, Math.floor(-metrics.offsetX / metrics.pitch)),
      endCol: Math.min(this.cols, Math.ceil((this.viewportWidthPx - metrics.offsetX) / metrics.pitch))
    };
  }

  private getGridMetrics(): GridMetrics {
    const pitch = this.cellSizePx * this.view.zoom;
    const fillSize = Math.max(0, pitch - this.cellGapPx * this.view.zoom);
    const inset = (pitch - fillSize) / 2;
    const gridWidthPx = this.cols * pitch;
    const gridHeightPx = this.rows * pitch;
    const offsetX = (this.viewportWidthPx - gridWidthPx) / 2 + this.view.panX;
    const offsetY = (this.viewportHeightPx - gridHeightPx) / 2 + this.view.panY;

    return {
      pitch,
      fillSize,
      inset,
      gridWidthPx,
      gridHeightPx,
      offsetX,
      offsetY
    };
  }

  private drawGridLines(
    offsetX: number,
    offsetY: number,
    _gridWidthPx: number,
    _gridHeightPx: number,
    pitch: number
  ): void {
    this.ctx.beginPath();
    this.ctx.strokeStyle = this.gridLineColor;
    // Thin dense lines at distant zoom levels so they do not obscure vehicles.
    this.ctx.lineWidth = Math.min(GRID_LINE_WIDTH_PX, pitch * 0.1);

    // Continue the background lattice across the viewport even beyond service coverage.
    const firstCol = Math.floor(-offsetX / pitch);
    const endCol = Math.ceil((this.viewportWidthPx - offsetX) / pitch);
    const firstRow = Math.floor(-offsetY / pitch);
    const endRow = Math.ceil((this.viewportHeightPx - offsetY) / pitch);
    for (let col = firstCol; col <= endCol; col += 1) {
      const x = offsetX + col * pitch;
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.viewportHeightPx);
    }

    for (let row = firstRow; row <= endRow; row += 1) {
      const y = offsetY + row * pitch;
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(this.viewportWidthPx, y);
    }

    this.ctx.stroke();
  }
}
