# Offscreen: drawing in a render worker

| Idea | Before | After | Speedup | Exact? | Peak RSS change | Lines added | Verdict |
|------|--------|-------|---------|--------|-----------------|-------------|---------|
| Render worker with OffscreenCanvas, sim worker posts snapshots to it over a MessagePort (`?offscreen=1`) | main thread busy 111% of wall time, 7-8 frames/s, timer lag median 200-270 ms (p95 320-370 ms) | busy 9-13%, 51-56 frames/s, lag median 0 ms (p95 3-6 ms, max 27-39 ms) | UI about 7x more frames, no stalls; the picture itself is not drawn faster (worker draws 7-9 frames/s) | Yes, 0 differing bytes of 4.13 MB, whole world and zoom x4 | Not measured; no extra snapshot copy, one more worker and its scratch arrays | about 200 (about 245 with the debug compare hook) | Merge-worthy for large worlds, with a fallback |

Setup: headless Chrome 154, software canvas (SwiftShader), 1500 x 1000 window (canvas 1119 x 923), Ecosystem page, `?threads=0`, world 20000 x 12500, 4000 start creatures (about 3800 alive, 20000 items), speed Max, 6 s warm-up and 12 s sampled, 3 alternating pairs. Load average was 11-14 from other sessions, so absolute numbers are pessimistic and the sim speed (0.6-1.0, simulated s per s) is too noisy to separate the two modes. Main-thread busy is the CDP `Performance.getMetrics` TaskDuration delta, which includes the paint that flushes the canvas. Lag is the lateness of a 10 ms timer on the main thread.

Per-pair results (base, then offscreen): busy 110.8 / 12.5, 111.2 / 8.8, 110.8 / 13.3 percent. Frames per second on the main thread 7.0 / 51.1, 7.3 / 56.0, 8.2 / 51.1. Worker draw rate 6.9, 8.6, 7.0 frames/s against 7.0, 7.3, 8.2 before, so the frame time of the picture is the same: software rasterisation of 20000 items is the cost, it just no longer blocks input, panning, the UI cards and the graphs. Sim speed (median) 0.7 / 0.7, 0.7 / 1.0, 0.8 / 0.8: no loss seen.

## How it works in the prototype

- `src/worker/renderWorker.ts` (96 lines) owns the OffscreenCanvas, the `EcoRenderer`, `BirthRings` and `ImpactEffects`. It keeps the newest frame request and draws it in its own `requestAnimationFrame` (falls back to a 16 ms timeout), so a slow draw drops frames instead of queueing them.
- `ecoWorker.ts` gets the MessageChannel port. Each snapshot goes to the render worker with the buffer transferred (plus events and the selected creature without its genome); the page gets the same message with an empty buffer. The render worker hands buffers back on the same port, so the existing recycle and in-flight limit work unchanged.
- The page keeps camera animation, follow, input, UI cards, overlays. Per animation frame it posts `{cx, cy, zoom, focusX, focusY}`, the draw config (winter tint included), the selected id, ray toggle, dpr and highlight. About 150 bytes.
- Selection: `selectedId` from the page gates the ring in the worker, so a deselect never shows a stale ring. The page no longer holds positions, so a click posts `pick` (world point and reach) to the worker, which runs the same `pickCreature` and answers with id and position, then `select()` proceeds as before.
- Birth rings and impact sparks run in the worker from the snapshots, timed with the worker's own `performance.now`, so the page sends nothing for them.
- Canvas size: after `transferControlToOffscreen` the page cannot set `canvas.width`. It computes the size from `clientWidth * dpr`, tells the worker, and camera input reads the size through a small `backing()` callback.
- Idle preview (before a run) is drawn by the worker too (`drawIdleWorld` runs there), because a canvas that has a main-thread context cannot be transferred. The transfer therefore happens at page load.

## Browser support and fallback

OffscreenCanvas with a 2D context in workers: Chrome 69+, Firefox 105+, Safari 16.4+ (per MDN and caniuse as remembered, not re-checked here; only Chrome 154 was run). The code feature-tests `transferControlToOffscreen` and otherwise keeps the existing main-thread path unchanged, which is also the default today. Also needed in the worker: `requestAnimationFrame` (unverified for Safari; the 16 ms timeout covers its absence) and `createImageBitmap`/`convertToBlob` only in the debug check. Risks not tested: Safari canvas memory limits at large sizes, dpr change by moving between displays (handled by `fitBacking`, untested), context loss, `?threads` helper pool interplay (unchanged, helpers talk only to the sim worker).

## Exactness check

Debug hook (`?offscreen=1` page, `__grab()`): pauses, waits for effects to fade, asks the worker for its canvas as PNG plus a copy of the snapshot, redraws that copy on the page thread with `EcoRenderer` and the page's camera, and compares all RGBA bytes. Whole world (zoom 0.054) and zoomed (0.22): 0 differing bytes. Not covered by this check: selection ring and rays, birth rings, impact sparks (they use the same code but go through the new transport and a different clock; visually unchecked).

## What it does not fix

- The drawing still takes the same CPU. On a machine with few cores it competes with the sim worker and helpers. On this 8-core box under load 12 the sim speed did not change measurably.
- Draw rate stays 7-9 frames/s in software mode, so panning and following show the picture at that rate even though the UI runs at 50+ frames/s. With a GPU the worker would be much faster; untested here.
- Lag between input and picture grows by about one worker frame; the UI itself stays responsive.

## Cost estimate for a production version

About 200 lines: renderWorker 96, renderProtocol 27, ecosystem.ts about 70 net (branches, pick round trip, size sync), ecoWorker 15, camera and cameraInput 25. Plus tests for the pick round trip and the stale-run guard (about 60). The Great Hunt page is the same script, so it comes free. Landing scenes (`landingScenes.ts`, 618 lines) draw on their own and would need separate work. New concepts: a third worker, a MessageChannel between workers, a second owner of births and impacts state.

Recommendation: worth merging behind the feature test, as the default where supported, since the page is unusable at 20000+ width today (111% main thread). Keep `?offscreen=0` as an escape hatch.

Prototype: branch worktree-agent-ade2ebfecdded4c15. Scripts: scratchpad `opt2/measure.mjs`, `opt2/pairs.sh`, results `opt2/runs.txt`. Remove the `__draws` timing lines and the `grab` debug hook before merging.
