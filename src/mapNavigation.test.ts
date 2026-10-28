import { describe, expect, it, vi } from "vitest";
import { bindMapNavigation } from "./mapNavigation";
import type { GridRenderer } from "./renderer";

function setup() {
  const element = () => Object.assign(new EventTarget(), { hidden: true, disabled: false });
  const canvas = Object.assign(element(), {
    dataset: {} as Record<string, string>,
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => false,
    releasePointerCapture: vi.fn()
  });
  const controls = element();
  const zoomIn = element();
  const zoomOut = element();
  const reset = element();
  const renderer = {
    getView: () => ({ zoom: 1, panX: 0, panY: 0 }),
    setView: vi.fn(), panBy: vi.fn(), zoomAt: vi.fn()
  };
  const navigation = bindMapNavigation({
    canvas: canvas as unknown as HTMLCanvasElement,
    controls: controls as unknown as HTMLElement,
    zoomIn: zoomIn as unknown as HTMLButtonElement,
    zoomOut: zoomOut as unknown as HTMLButtonElement,
    reset: reset as unknown as HTMLButtonElement,
    getRenderer: () => renderer as unknown as GridRenderer,
    onViewChanged: vi.fn(), onGestureStart: vi.fn()
  });
  const pointer = (type: string, x: number, y: number, id = 1) => {
    canvas.dispatchEvent(Object.assign(new Event(type), {
      pointerId: id, button: 0, clientX: x, clientY: y
    }));
  };
  return { canvas, controls, zoomIn, reset, renderer, navigation, pointer };
}

describe("map navigation", () => {
  it("only enables gestures and reveals controls in hidden-content mode, then resets", () => {
    const { canvas, controls, zoomIn, renderer, navigation, pointer } = setup();
    navigation.setEnabled(false);
    pointer("pointerdown", 10, 10);
    pointer("pointermove", 30, 20);
    zoomIn.dispatchEvent(new Event("click"));
    expect(renderer.panBy).not.toHaveBeenCalled();
    expect(renderer.zoomAt).not.toHaveBeenCalled();
    expect(controls.hidden).toBe(true);
    navigation.setEnabled(true);
    expect(controls.hidden).toBe(false);
    zoomIn.dispatchEvent(new Event("click"));
    expect(renderer.zoomAt).toHaveBeenCalledWith(1.25);
    pointer("pointerdown", 10, 10);
    pointer("pointermove", 30, 20);
    expect(renderer.panBy).toHaveBeenCalledWith(20, 10);
    expect(canvas.dataset.dragging).toBe("true");
    navigation.setEnabled(false);
    expect(controls.hidden).toBe(true);
    expect(renderer.setView).toHaveBeenLastCalledWith({ zoom: 1, panX: 0, panY: 0 });
    expect(canvas.dataset.dragging).toBe("false");
  });

  it("suppresses selection clicks after dragging, but allows the next tap", () => {
    const { canvas, navigation, pointer } = setup();
    navigation.setEnabled(true);
    pointer("pointerdown", 10, 10);
    pointer("pointermove", 30, 20);
    pointer("pointerup", 30, 20);
    const dragClick = new Event("click", { cancelable: true });
    canvas.dispatchEvent(dragClick);
    expect(dragClick.defaultPrevented).toBe(true);
    pointer("pointerdown", 30, 20);
    pointer("pointerup", 30, 20);
    const tapClick = new Event("click", { cancelable: true });
    canvas.dispatchEvent(tapClick);
    expect(tapClick.defaultPrevented).toBe(false);
  });

  it("only intercepts wheel zoom while enabled and anchors it at the pointer", () => {
    const { canvas, navigation, renderer } = setup();
    const wheel = () => Object.assign(new Event("wheel", { cancelable: true }), {
      deltaY: -100, deltaMode: 0, clientX: 12, clientY: 24
    });
    const disabledEvent = wheel();
    canvas.dispatchEvent(disabledEvent);
    expect(disabledEvent.defaultPrevented).toBe(false);
    expect(renderer.zoomAt).not.toHaveBeenCalled();
    navigation.setEnabled(true);
    const enabledEvent = wheel();
    canvas.dispatchEvent(enabledEvent);
    expect(enabledEvent.defaultPrevented).toBe(true);
    expect(renderer.zoomAt).toHaveBeenCalledWith(Math.exp(0.2), 12, 24);
  });

  it("ignores small tap movements and uses two pointers for pinch zoom", () => {
    const { renderer, navigation, pointer } = setup();
    navigation.setEnabled(true);
    pointer("pointerdown", 10, 10);
    pointer("pointermove", 12, 11);
    expect(renderer.panBy).not.toHaveBeenCalled();
    pointer("pointerdown", 30, 10, 2);
    pointer("pointermove", 50, 10, 2);
    expect(renderer.zoomAt).toHaveBeenCalledWith(2, 20, 10);
    expect(renderer.panBy).toHaveBeenCalledWith(10, 0);
  });
});
