// @vitest-environment happy-dom
import { Camera } from "../../src/typescript/src/ui/camera.ts";

// Backing store 1000 x 800 drawn at 500 x 400 CSS px, so one CSS px is 2 device pixels.
function setup() {
  const canvas = document.createElement("canvas");
  canvas.tabIndex = 0;
  canvas.width = 1000;
  canvas.height = 800;
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 400, right: 500, bottom: 400, x: 0, y: 0, toJSON() {} });
  document.body.append(canvas);
  const cam = new Camera(4000, 2500, 1000, 800, 5);
  cam.zoomAt(500, 400, 3);
  const onClick = vi.fn();
  cam.onClick = onClick;
  const detach = cam.attach(canvas);
  return { canvas, cam, onClick, detach };
}

const ptr = (type: string, id: number, x: number, y: number, init: PointerEventInit = {}) =>
  new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, pointerType: "mouse", button: 0, bubbles: true, ...init });
const key = (k: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });

afterEach(() => {
  document.body.innerHTML = "";
});

describe("pointer", () => {
  it("a press within the CSS threshold clicks, a drag beyond it does not", () => {
    const { canvas, cam, onClick } = setup();
    canvas.dispatchEvent(ptr("pointerdown", 1, 100, 100));
    canvas.dispatchEvent(ptr("pointermove", 1, 103, 100)); // 3 CSS px = 6 device px, over the old 5 device px limit
    canvas.dispatchEvent(ptr("pointerup", 1, 103, 100));
    expect(onClick).toHaveBeenCalledTimes(1);

    const cx = cam.cx;
    canvas.dispatchEvent(ptr("pointerdown", 1, 100, 100));
    canvas.dispatchEvent(ptr("pointermove", 1, 120, 100));
    canvas.dispatchEvent(ptr("pointerup", 1, 120, 100));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(cam.cx).toBeLessThan(cx);
  });

  it("touch tolerates more movement than a mouse", () => {
    const { canvas, onClick } = setup();
    const touch = { pointerType: "touch" };
    canvas.dispatchEvent(ptr("pointerdown", 1, 100, 100, touch));
    canvas.dispatchEvent(ptr("pointermove", 1, 108, 100, touch));
    canvas.dispatchEvent(ptr("pointerup", 1, 108, 100, touch));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("right-click neither pans nor clicks", () => {
    const { canvas, cam, onClick } = setup();
    const cx = cam.cx;
    const right = { button: 2 };
    canvas.dispatchEvent(ptr("pointerdown", 1, 100, 100, right));
    canvas.dispatchEvent(ptr("pointermove", 1, 200, 100, right));
    canvas.dispatchEvent(ptr("pointerup", 1, 200, 100, right));
    expect(cam.cx).toBe(cx);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("a pointer left over before a window blur does not turn the next press into a pinch", () => {
    const { canvas, cam } = setup();
    canvas.dispatchEvent(ptr("pointerdown", 1, 100, 100)); // its pointerup never arrives
    window.dispatchEvent(new Event("blur"));
    canvas.dispatchEvent(ptr("pointerdown", 2, 300, 100));
    const { zoom, cx } = cam;
    canvas.dispatchEvent(ptr("pointermove", 2, 350, 100));
    expect(cam.zoom).toBe(zoom);
    expect(cx - cam.cx).toBeCloseTo(100 / zoom); // 50 CSS px = 100 device px, whole travel
  });

  it("lostpointercapture also forgets the pointer", () => {
    const { canvas, cam } = setup();
    canvas.dispatchEvent(ptr("pointerdown", 1, 100, 100));
    canvas.dispatchEvent(ptr("lostpointercapture", 1, 100, 100));
    canvas.dispatchEvent(ptr("pointerdown", 2, 300, 100));
    const zoom = cam.zoom;
    canvas.dispatchEvent(ptr("pointermove", 2, 350, 100));
    expect(cam.zoom).toBe(zoom);
  });
});

describe("keyboard", () => {
  it("is ignored unless the canvas has focus, or the event was already handled", () => {
    const { canvas, cam } = setup();
    const cx = cam.cx;
    window.dispatchEvent(key("ArrowRight"));
    document.body.dispatchEvent(key("ArrowRight"));
    expect(cam.animating).toBe(false);
    expect(cam.cx).toBe(cx);

    canvas.focus();
    canvas.addEventListener("keydown", (e) => e.preventDefault(), { capture: true, once: true });
    canvas.dispatchEvent(key("ArrowRight"));
    expect(cam.animating).toBe(false); // defaultPrevented

    canvas.dispatchEvent(key("ArrowRight"));
    expect(cam.animating).toBe(true);
  });

  it("targets build on the animation goal, not the mid-flight view", () => {
    const { canvas, cam } = setup();
    canvas.focus();
    const cx0 = cam.cx;
    canvas.dispatchEvent(key("ArrowRight"));
    const first = cam.goal.cx;
    cam.update(0);
    cam.update(50); // barely moved, ease-in
    canvas.dispatchEvent(key("ArrowRight"));
    expect(cam.goal.cx - first).toBeCloseTo(first - cx0, 0);
  });

  it("a held key moves the camera on every repeat", () => {
    const { canvas, cam } = setup();
    canvas.focus();
    const xs = [cam.cx];
    for (let i = 0; i < 6; i++) {
      canvas.dispatchEvent(key("ArrowRight", { repeat: i > 0 }));
      cam.update(i * 16);
      xs.push(cam.cx);
    }
    for (let i = 2; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!); // the first press eases in from rest
    const zs = [cam.zoom];
    for (let i = 0; i < 4; i++) {
      canvas.dispatchEvent(key("+", { repeat: true }));
      zs.push(cam.zoom);
    }
    for (let i = 1; i < zs.length; i++) expect(zs[i]!).toBeGreaterThan(zs[i - 1]!);
  });
});

describe("wheel", () => {
  // happy-dom's WheelEvent drops the mouse fields, so they are set on the event itself.
  const wheel = (init: WheelEventInit) => {
    const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
    Object.defineProperties(e, { ctrlKey: { value: init.ctrlKey ?? false }, clientX: { value: 250 }, clientY: { value: 200 } });
    return e;
  };

  it("ctrl+wheel zooms at the cursor", () => {
    const { canvas, cam } = setup();
    const zoom = cam.zoom;
    canvas.dispatchEvent(wheel({ deltaY: -5, ctrlKey: true }));
    expect(cam.zoom).toBeGreaterThan(zoom);
  });

  it("a line-mode mouse wheel zooms", () => {
    const { canvas, cam } = setup();
    const zoom = cam.zoom;
    canvas.dispatchEvent(wheel({ deltaY: -3, deltaMode: 1 }));
    expect(cam.zoom).toBeGreaterThan(zoom);
  });

  it("a small pixel-mode scroll pans and does not zoom", () => {
    const { canvas, cam } = setup();
    const { zoom, cx, cy } = cam;
    canvas.dispatchEvent(wheel({ deltaX: 10, deltaY: 6 }));
    expect(cam.zoom).toBe(zoom);
    expect(cam.cx).toBeGreaterThan(cx);
    expect(cam.cy).toBeGreaterThan(cy);
  });
});
