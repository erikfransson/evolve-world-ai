import type { Camera } from "./camera.ts";
import { DragDetector } from "./camera.ts";

const DRAG_CSS_PX = { mouse: 4, touch: 10 }; // CSS pixels of movement before a press becomes a drag
const WHEEL_STEP_PX = 50; // a pixel-mode vertical step at least this big (and no deltaX) is a mouse wheel notch
const WHEEL_K = 0.0015; // zoom factor is exp(-deltaY * k)
const PINCH_WHEEL_K = 0.01; // trackpad pinch arrives as ctrl+wheel with small deltas
const KEY_ZOOM = 1.25;
const KEY_PAN = 0.15; // fraction of the view per arrow press
const KEY_REPEAT = 1 / 3; // auto-repeat events apply this share of a press directly, so held keys glide
const DBLCLICK_ZOOM = 2.5;

// Canvas-relative position in backing-store pixels, so it holds for any devicePixelRatio and CSS size.
function pos(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: ((clientX - r.left) * canvas.width) / (r.width || 1), y: ((clientY - r.top) * canvas.height) / (r.height || 1) };
}

export function attachCameraInput(cam: Camera, canvas: HTMLCanvasElement): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let drag = new DragDetector(0);
  let startX = 0;
  let startY = 0;
  let pinchDist = 0;
  const prevTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = "none";

  const pinchState = (): { dist: number; x: number; y: number } => {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y), x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
  };

  // Backing-store pixels per CSS pixel.
  const cssScale = (): number => canvas.width / (canvas.getBoundingClientRect().width || 1);

  const onDown = (e: PointerEvent): void => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const p = pos(canvas, e.clientX, e.clientY);
    pointers.set(e.pointerId, p);
    canvas.setPointerCapture?.(e.pointerId);
    if (pointers.size === 1) {
      drag = new DragDetector((e.pointerType === "touch" ? DRAG_CSS_PX.touch : DRAG_CSS_PX.mouse) * cssScale());
      drag.start(p.x, p.y);
      startX = p.x;
      startY = p.y;
    } else if (pointers.size === 2) {
      pinchDist = pinchState().dist;
      drag.dragging = true; // a second finger is never a click
      cam.cancel();
    }
  };

  const onMove = (e: PointerEvent): void => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const p = pos(canvas, e.clientX, e.clientY);
    pointers.set(e.pointerId, p);
    if (pointers.size >= 2) {
      const s = pinchState();
      if (pinchDist > 0 && s.dist > 0) cam.zoomAt(s.x, s.y, s.dist / pinchDist);
      pinchDist = s.dist;
      cam.panBy((p.x - prev.x) / 2, (p.y - prev.y) / 2); // the midpoint moves by half of one finger
      return;
    }
    const was = drag.dragging;
    if (!drag.move(p.x, p.y)) return;
    if (!was) cam.cancel();
    // The move that crosses the threshold applies the whole travel since pointerdown.
    if (was) cam.panBy(p.x - prev.x, p.y - prev.y);
    else cam.panBy(p.x - startX, p.y - startY);
  };

  const onUp = (e: PointerEvent): void => {
    const p = pointers.get(e.pointerId);
    pointers.delete(e.pointerId);
    pinchDist = 0;
    if (!p) return;
    if (pointers.size === 0 && e.type === "pointerup" && !drag.dragging && cam.onClick) {
      const w = cam.screenToWorld(p.x, p.y);
      cam.onClick(w.x, w.y);
    }
    if (pointers.size === 1) drag.dragging = true; // the remaining finger of a pinch pans, never clicks
  };

  // ctrl+wheel (trackpad pinch) and mouse wheels zoom at the cursor, a trackpad two-finger scroll pans.
  // A mouse wheel reports line or page units, or pixel steps of 50+ with no deltaX. Small pixel deltas or any deltaX mean a trackpad.
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const zooms = e.ctrlKey || e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= WHEEL_STEP_PX);
    if (!zooms) {
      cam.cancel();
      const k = cssScale();
      cam.panBy(-e.deltaX * k, -e.deltaY * k);
      return;
    }
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const factor = Math.exp(-e.deltaY * unit * (e.ctrlKey ? PINCH_WHEEL_K : WHEEL_K));
    if (cam.following) {
      cam.zoomAt(canvas.width / 2, canvas.height / 2, factor); // keeps the followed target centred
      return;
    }
    cam.cancel();
    const p = pos(canvas, e.clientX, e.clientY);
    cam.zoomAt(p.x, p.y, factor);
  };

  const onDblClick = (e: MouseEvent): void => {
    const p = pos(canvas, e.clientX, e.clientY);
    const v = cam.viewZoomingAt(p.x, p.y, cam.zoom * DBLCLICK_ZOOM);
    cam.cancel();
    cam.animateTo(v.cx, v.cy, v.zoom);
  };

  const clearPointers = (): void => {
    pointers.clear();
    pinchDist = 0;
  };

  const onLostCapture = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    pinchDist = 0;
  };

  // Keys act only while the canvas has focus. Targets build on the animation goal, repeats move the view directly.
  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const g = cam.goal;
    const step = e.repeat ? KEY_REPEAT : 1;
    let { cx, cy, zoom } = g;
    const vw = canvas.width / zoom;
    const vh = canvas.height / zoom;
    switch (e.key) {
      case "+":
      case "=":
        zoom *= KEY_ZOOM ** step;
        break;
      case "-":
      case "_":
        zoom /= KEY_ZOOM ** step;
        break;
      case "ArrowLeft":
        cx -= vw * KEY_PAN * step;
        break;
      case "ArrowRight":
        cx += vw * KEY_PAN * step;
        break;
      case "ArrowUp":
        cy -= vh * KEY_PAN * step;
        break;
      case "ArrowDown":
        cy += vh * KEY_PAN * step;
        break;
      case "0":
        e.preventDefault();
        cam.cancel();
        cam.animateToFit();
        return;
      default:
        return;
    }
    e.preventDefault();
    if (e.repeat) cam.setView(cx, cy, zoom);
    else {
      cam.cancel();
      cam.animateTo(cx, cy, zoom);
    }
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("lostpointercapture", onLostCapture);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("dblclick", onDblClick);
  canvas.addEventListener("keydown", onKey);
  window.addEventListener("blur", clearPointers);
  return () => {
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onUp);
    canvas.removeEventListener("lostpointercapture", onLostCapture);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("dblclick", onDblClick);
    canvas.removeEventListener("keydown", onKey);
    window.removeEventListener("blur", clearPointers);
    canvas.style.touchAction = prevTouchAction;
    pointers.clear();
  };
}
