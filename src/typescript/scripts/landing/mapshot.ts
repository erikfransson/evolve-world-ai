// Renders the Inland Sea picture and grid for the landing Live World card (src/ui/landing/inland-sea.webp, inlandGrid.ts). Open
// /scripts/landing/mapshot.html under `npx vite` and save window.__out.webp and window.__out.grid.
import { terrainOf } from "../../src/sim/terrain.ts";
import { mapSpec } from "../../src/sim/maps/index.ts";
import { drawTerrain } from "../../src/ui/terrainScene.ts";
import { FLOOR } from "../../src/ui/scene.ts";
const spec = mapSpec("inland-sea")!;
const W = 1280, H = 800, GW = 160, GH = 100;
const t = terrainOf({ seed: 0, world: { width: spec.width, height: spec.height, stoneDensity: 0, ridgeDensity: 0, slowDensity: 0, fastDensity: 0, map: spec.name } });
const c = document.getElementById("c") as HTMLCanvasElement;
c.width = W; c.height = H;
const ctx = c.getContext("2d")!;
const s = W / spec.width;
ctx.setTransform(s, 0, 0, s, 0, 0);
ctx.fillStyle = FLOOR; ctx.fillRect(0, 0, spec.width, spec.height);
drawTerrain(ctx, t, s);
const w = t.weights!;
let maxF = 0, maxP = 0;
const cw = spec.width / GW, ch = spec.height / GH;
const fb: number[] = [], pb: number[] = [], rk: number[] = [];
for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
  const x = (i + 0.5) * cw, y = (j + 0.5) * ch;
  const f = w.byteAt(0, x, y), p = w.byteAt(1, x, y);
  fb.push(f); pb.push(p); rk.push(t.touchesRock(x, y, 0.35 * cw) ? 1 : 0);
  maxF = Math.max(maxF, f); maxP = Math.max(maxP, p);
}
const bytes = new Uint8Array(GW * GH);
for (let k = 0; k < bytes.length; k++) bytes[k] = (rk[k]! << 7) | (Math.round((7 * pb[k]!) / (maxP || 1)) << 4) | Math.round((15 * fb[k]!) / (maxF || 1));
let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
(window as any).__out = { webp: c.toDataURL("image/webp", 0.82), grid: btoa(bin), GW, GH, title: spec.title };
