interface RendererOptions {
  canvas: HTMLCanvasElement;
  rows: number;
  cols: number;
  cellSizePx: number;
  cellGapPx: number;
  transitionMs: number;
  gridLineColor?: string;
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
  private readonly fromBuffer: Float32Array;
  private readonly toBuffer: Float32Array;
  private readonly frameBuffer: Float32Array;
  private gridLineColor: string;
  private dpr = 1;
  private viewportWidthPx = 0;
  private viewportHeightPx = 0;
  private transitionStartMs = 0;
  private rafId: number | null = null;

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
    this.gridLineColor = options.gridLineColor ?? DEFAULT_GRID_LINE_COLOR;

    const channelCount = this.rows * this.cols * 4;
    this.fromBuffer = new Float32Array(channelCount);
    this.toBuffer = new Float32Array(channelCount);
    this.frameBuffer = new Float32Array(channelCount);
  }

  public resize(widthPx: number = window.innerWidth, heightPx: number = window.innerHeight): void {
    this.viewportWidthPx = widthPx;
    this.viewportHeightPx = heightPx;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.ctx.canvas.width = Math.max(1, Math.floor(widthPx * this.dpr));
    this.ctx.canvas.height = Math.max(1, Math.floor(heightPx * this.dpr));
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  public setState(nextBuffer: Float32Array, nowMs: number = performance.now()): void {
    if (nextBuffer.length !== this.toBuffer.length) {
      throw new Error("Incoming state buffer does not match renderer grid size.");
    }

    this.fromBuffer.set(this.frameBuffer);
    this.toBuffer.set(nextBuffer);
    this.transitionStartMs = nowMs;
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

  private draw(nowMs: number): void {
    const progress = this.transitionMs <= 0 ? 1 : (nowMs - this.transitionStartMs) / this.transitionMs;
    interpolateBuffers(this.fromBuffer, this.toBuffer, progress, this.frameBuffer);
    this.drawFrame(this.frameBuffer);
  }

  private drawFrame(buffer: Float32Array): void {
    const pitch = this.cellSizePx;
    const fillSize = Math.max(0, this.cellSizePx - this.cellGapPx);
    const inset = (pitch - fillSize) / 2;
    const gridWidthPx = this.cols * pitch;
    const gridHeightPx = this.rows * pitch;
    const offsetX = (this.viewportWidthPx - gridWidthPx) / 2;
    const offsetY = (this.viewportHeightPx - gridHeightPx) / 2;

    this.ctx.clearRect(0, 0, this.viewportWidthPx, this.viewportHeightPx);
    this.drawGridLines(offsetX, offsetY, gridWidthPx, gridHeightPx, pitch);

    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const index = row * this.cols + col;
        const offset = index * 4;
        const alpha = buffer[offset + 3];

        if (alpha <= 0.001) {
          continue;
        }

        this.ctx.fillStyle = `rgba(${Math.round(buffer[offset])}, ${Math.round(buffer[offset + 1])}, ${Math.round(buffer[offset + 2])}, ${alpha.toFixed(4)})`;
        this.ctx.fillRect(
          offsetX + col * pitch + inset,
          offsetY + row * pitch + inset,
          fillSize,
          fillSize
        );
      }
    }
  }

  private drawGridLines(
    offsetX: number,
    offsetY: number,
    gridWidthPx: number,
    gridHeightPx: number,
    pitch: number
  ): void {
    this.ctx.beginPath();
    this.ctx.strokeStyle = this.gridLineColor;
    this.ctx.lineWidth = GRID_LINE_WIDTH_PX;

    for (let col = 0; col <= this.cols; col += 1) {
      const x = offsetX + col * pitch;
      this.ctx.moveTo(x, offsetY);
      this.ctx.lineTo(x, offsetY + gridHeightPx);
    }

    for (let row = 0; row <= this.rows; row += 1) {
      const y = offsetY + row * pitch;
      this.ctx.moveTo(offsetX, y);
      this.ctx.lineTo(offsetX + gridWidthPx, y);
    }

    this.ctx.stroke();
  }
}
