import { describe, expect, it } from "vitest";
import { GridRenderer, interpolateBuffers } from "./renderer";

describe("interpolateBuffers", () => {
  it("fades newly activated cells from white", () => {
    const from = new Float32Array([0, 0, 0, 0, 100, 150, 200, 1]);
    const to = new Float32Array([10, 20, 30, 0.5, 40, 50, 60, 0.2]);

    const out = interpolateBuffers(from, to, 0.5);
    expect(out[0]).toBeCloseTo(132.5);
    expect(out[1]).toBeCloseTo(137.5);
    expect(out[2]).toBeCloseTo(142.5);
    expect(out[3]).toBeCloseTo(0.25);
    expect(out[4]).toBeCloseTo(70);
    expect(out[5]).toBeCloseTo(100);
    expect(out[6]).toBeCloseTo(130);
    expect(out[7]).toBeCloseTo(0.6);
  });

  it("clamps progress values outside the 0..1 range", () => {
    const from = new Float32Array([10, 20, 30, 0.4]);
    const to = new Float32Array([100, 110, 120, 0.9]);

    const outLow = interpolateBuffers(from, to, -2);
    const outHigh = interpolateBuffers(from, to, 3);

    expect(Array.from(outLow)).toEqual(Array.from(from));
    expect(Array.from(outHigh)).toEqual(Array.from(to));
  });
});

function createRendererWithContext(gridLineColor?: string): {
  renderer: GridRenderer;
  context: CanvasRenderingContext2D;
} {
  const context = {
    canvas: { width: 0, height: 0 },
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
    clearRect: () => undefined,
    fillRect: () => undefined,
    setTransform: () => undefined
  } as unknown as CanvasRenderingContext2D;

  const canvas = {
    getContext: () => context
  } as unknown as HTMLCanvasElement;

  return {
    context,
    renderer: new GridRenderer({
      canvas,
      rows: 2,
      cols: 2,
      cellSizePx: 10,
      cellGapPx: 1,
      transitionMs: 100,
      gridLineColor
    })
  };
}

describe("GridRenderer grid line color", () => {
  it("uses a custom constructor grid line color", () => {
    const expectedColor = "rgba(12, 34, 56, 0.6)";
    const { renderer, context } = createRendererWithContext(expectedColor);

    (
      renderer as unknown as {
        drawGridLines: (
          offsetX: number,
          offsetY: number,
          gridWidthPx: number,
          gridHeightPx: number,
          pitch: number
        ) => void;
      }
    ).drawGridLines(0, 0, 20, 20, 10);

    expect(context.strokeStyle).toBe(expectedColor);
  });

  it("updates grid line color through setGridLineColor", () => {
    const { renderer, context } = createRendererWithContext("rgba(10, 20, 30, 0.2)");
    const updatedColor = "rgba(120, 140, 160, 0.35)";

    renderer.setGridLineColor(updatedColor);
    (
      renderer as unknown as {
        drawGridLines: (
          offsetX: number,
          offsetY: number,
          gridWidthPx: number,
          gridHeightPx: number,
          pitch: number
        ) => void;
      }
    ).drawGridLines(0, 0, 20, 20, 10);

    expect(context.strokeStyle).toBe(updatedColor);
  });
});
