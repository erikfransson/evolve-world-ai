import { Camera, DragDetector, fitWorld } from "../../src/typescript/src/ui/camera.ts";

const make = () => new Camera(4000, 2500, 1000, 800, 5);

describe("camera maths", () => {
  it("round trips world and screen", () => {
    const c = make();
    c.zoomAt(300, 200, 3);
    c.panBy(-50, 30);
    const s = c.worldToScreen(1234, 987);
    const w = c.screenToWorld(s.x, s.y);
    expect(w.x).toBeCloseTo(1234);
    expect(w.y).toBeCloseTo(987);
  });

  it("maps the centre to the middle of the canvas", () => {
    const c = make();
    const s = c.worldToScreen(c.cx, c.cy);
    expect(s).toEqual({ x: 500, y: 400 });
  });

  it("zoom at the cursor keeps the point under it fixed", () => {
    const c = make();
    c.zoomAt(500, 400, 4);
    const before = c.screenToWorld(700, 300);
    c.zoomAt(700, 300, 1.7);
    const after = c.screenToWorld(700, 300);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("clamps zoom between fit and max", () => {
    const c = make();
    c.zoomAt(100, 100, 1e6);
    expect(c.zoom).toBe(5);
    c.zoomAt(100, 100, 1e-9);
    expect(c.zoom).toBeCloseTo(fitWorld(4000, 2500, 1000, 800));
  });

  it("clamps the centre so the world cannot leave the screen", () => {
    const c = make();
    c.zoomAt(500, 400, 8);
    c.panBy(1e7, -1e7);
    expect(c.cx).toBeGreaterThan(0);
    expect(c.cx).toBeLessThan(4000 / 2);
    const s = c.worldToScreen(0, 2500);
    expect(s.x).toBeLessThan(1000);
    expect(s.y).toBeGreaterThan(0);
    c.panBy(-1e8, 1e8);
    expect(c.worldToScreen(4000, 0).x).toBeGreaterThan(0);
  });

  it("keeps the world centred when fully zoomed out", () => {
    const c = make();
    c.panBy(500, 500);
    expect(c.cx).toBe(2000);
    expect(c.cy).toBe(1250);
  });

  it("fitWorld handles wide, tall and square canvases", () => {
    expect(fitWorld(4000, 2500, 800, 800)).toBeCloseTo((800 / 4000) * 0.96); // width bound
    expect(fitWorld(4000, 2500, 4000, 500)).toBeCloseTo((500 / 2500) * 0.96); // height bound
    expect(fitWorld(1000, 1000, 500, 500)).toBeCloseTo(0.48);
    const z = fitWorld(4000, 2500, 1600, 900);
    expect(4000 * z).toBeLessThan(1600);
    expect(2500 * z).toBeLessThan(900);
  });

  it("resize keeps a fitted view fitted", () => {
    const c = make();
    c.resize(2000, 1000);
    expect(c.zoom).toBeCloseTo(fitWorld(4000, 2500, 2000, 1000));
  });
});

describe("camera motion", () => {
  it("follow converges to a moving target and stops on cancel", () => {
    const c = make();
    c.zoomAt(500, 400, 4);
    const t = { x: 3000, y: 1800 };
    c.follow(() => t);
    for (let ms = 0; ms <= 3000; ms += 16) c.update(ms);
    expect(c.cx).toBeCloseTo(3000, 0);
    expect(c.cy).toBeCloseTo(1800, 0);
    c.cancel();
    t.x = 500;
    c.update(3100);
    expect(c.cx).toBeCloseTo(3000, 0);
  });

  it("follow stops when the target disappears", () => {
    const c = make();
    c.follow(() => null);
    c.update(0);
    expect(c.following).toBe(false);
  });

  it("animateTo lands on the clamped view after 400 ms", () => {
    const c = make();
    c.animateTo(1000, 800, 3);
    c.update(0);
    expect(c.zoom).toBeCloseTo(c.minZoom);
    c.update(200);
    expect(c.zoom).toBeGreaterThan(c.minZoom);
    expect(c.zoom).toBeLessThan(3);
    c.update(400);
    expect(c.zoom).toBeCloseTo(3);
    expect(c.cx).toBeCloseTo(1000);
    expect(c.animating).toBe(false);
  });

  it("counts finished animations but not cancelled ones", () => {
    const c = make();
    c.animateTo(1000, 800, 3);
    c.update(0);
    c.cancel();
    expect(c.animationsCompleted).toBe(0);
    c.animateTo(1000, 800, 3);
    c.update(500);
    c.update(1000);
    expect(c.animationsCompleted).toBe(1);
  });
});

describe("DragDetector", () => {
  it("small movement stays a click, larger becomes a drag and stays one", () => {
    const d = new DragDetector(5);
    d.start(100, 100);
    expect(d.move(103, 104)).toBe(false);
    expect(d.move(106, 100)).toBe(true);
    expect(d.move(100, 100)).toBe(true);
    d.start(0, 0);
    expect(d.dragging).toBe(false);
  });
});
