import { describe, expect, it } from "vitest";
import { interpolateBuffers } from "./renderer";

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
