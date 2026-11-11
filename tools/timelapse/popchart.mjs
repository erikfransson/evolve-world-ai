// Line chart of population per founder lineage over simulated time, from a world folder's population.jsonl. Writes an SVG (dependency-free) and, with png=1, a PNG through headless Chrome.
// Run: node tools/timelapse/popchart.mjs <world folder> [outdir=<output folder>] [out=<file.svg>] [png=1]   View: open the SVG in a browser or image viewer.
// outdir defaults to videos/timelapse of this checkout, as in timelapse.mjs; the world folder must be directly inside it.
// The world folder is written by the capture unit, so everything read from it is hostile: names lose control characters, numbers must be finite, and outputs never write through a link.
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { clean, num, readHostile, writeFresh } from "./hostile.mjs";

const [dirArg, ...rest] = process.argv.slice(2);
if (!dirArg) { console.error("usage: node popchart.mjs <world folder> [outdir=<output folder>] [out=file.svg] [png=1]"); process.exit(2); }
const opt = Object.fromEntries(rest.map((a) => { const i = a.indexOf("="); return [a.slice(0, i), a.slice(i + 1)]; }));
const refuse = (...m) => { console.error("refused:", ...m); process.exit(1); };
const MAX_INPUT = 64e6, MAX_LINES = 1_000_000, MAX_ROWS = 200_000, MAX_POINTS = 1_000_000, LINE_POINTS = 2000; // input bytes, lines scanned, rows kept, points kept in memory, points drawn per line (the plot is 1280 px wide)
const MAX_LINEAGES = 64; // in the chart; the server sends at most 8 per line
const MAX_LINE = 16384; // a longer line is skipped unparsed (a real one is under 1 kB; JSON.parse of one 60 MB line of `[` took 2.8 GB)
const W = 1600, H = 900, L = 90, R = 230, T = 40, B = 70; // chart size and margins in px
const CHROME = "/usr/bin/google-chrome";

// Paths: the world folder must be a real folder directly inside the real output folder (no link anywhere below the output folder, also not through a trailing slash),
// and an output file must sit in that world folder or outside the output folder, and must not be a folder or special file.
const strip = (p) => p.replace(/\/+$/, "") || "/";
let OUTDIR;
try { OUTDIR = realpathSync(resolve(opt.outdir ?? join(import.meta.dirname, "../../videos/timelapse"))); } catch { refuse("no output folder", clean(opt.outdir ?? "", 200), "(set outdir=)"); }
const worldArg = resolve(strip(dirArg));
let wst; try { wst = lstatSync(worldArg); } catch { refuse("no world folder", clean(worldArg, 200)); }
if (!wst.isDirectory()) refuse(clean(worldArg, 200), "is a link or not a folder");
let parentReal; try { parentReal = realpathSync(dirname(worldArg)); } catch { refuse("cannot resolve", clean(dirname(worldArg), 200)); }
if (parentReal !== OUTDIR) refuse(clean(worldArg, 200), "is not a folder directly inside the output folder", OUTDIR, "(set outdir=)");
const dir = join(OUTDIR, basename(worldArg));
function outputPath(p) {
  const f = resolve(strip(p));
  let pr; try { pr = realpathSync(dirname(f)); } catch { refuse("no folder for", clean(f, 200)); }
  if (pr !== dir && (pr === OUTDIR || pr.startsWith(OUTDIR + sep))) refuse(clean(f, 200), "is inside the output folder but not in this world folder");
  const real = join(pr, basename(f));
  try { const st = lstatSync(real); if (!st.isFile() && !st.isSymbolicLink()) refuse(clean(real, 200), "exists and is not a regular file"); } catch (e) { if (e.code !== "ENOENT") throw e; }
  return real; // a link there is replaced by the rename, never written through
}
const out = outputPath(opt.out ?? join(dir, "population.svg"));
const pngOut = opt.png === "1" ? outputPath(out.replace(/\.svg$/, "") + ".png") : null;

const popFile = join(dir, "population.jsonl");
try { const n = lstatSync(popFile).size; if (n > MAX_INPUT) refuse(`population.jsonl is ${Math.round(n / 1e6)} MB, over the ${MAX_INPUT / 1e6} MB this tool reads`); } catch (e) { if (e.code === "ENOENT") refuse("no population.jsonl"); throw e; }
const text = readHostile(popFile, MAX_INPUT);
if (text === null) refuse("population.jsonl is not a regular file, or too large");
const lines = new Map(); // name (or founder id) -> { name, hue, max, pts: [[hours, count]] }
const total = []; // [hours, population]
let t0 = null, nRows = 0, nPoints = 0, nLines = 0, capped = "";
for (let pos = 0; pos < text.length; ) { // line by line without split, so junk lines cost no array
  let e = text.indexOf("\n", pos); if (e < 0) e = text.length;
  const l = text.slice(pos, e); pos = e + 1;
  if (!l) continue;
  if (++nLines > MAX_LINES) { capped = `only the first ${MAX_LINES} lines are read`; break; }
  if (nRows >= MAX_ROWS) { capped = `only the first ${MAX_ROWS} rows are charted`; break; }
  if (l.length > MAX_LINE) continue;
  let r; try { r = JSON.parse(l); } catch { continue; }
  if (!r || typeof r !== "object" || Array.isArray(r) || num(r.simSeconds) === null) continue; // only object rows with a finite time
  const sim = r.simSeconds; t0 ??= sim;
  const h = (sim - t0) / 3600;
  total.push([h, num(r?.population) ?? 0]); nRows++;
  for (const g of Array.isArray(r?.lineages) ? r.lineages.slice(0, 32) : []) {
    if (nPoints >= MAX_POINTS) { capped ||= `point cap of ${MAX_POINTS} reached, later lineage points are left out`; break; }
    const name = clean(g?.name, 40) || "#" + (num(g?.founder) ?? "?"); // the group's founder id is its lowest living one and changes as founders die, the name stays
    let s = lines.get(name);
    if (!s) { if (lines.size >= MAX_LINEAGES) continue; lines.set(name, (s = { name, hue: num(g?.hue) ?? -1, max: 0, pts: [] })); }
    const c = num(g?.count) ?? 0; s.pts.push([h, c]); if (c > s.max) s.max = c; nPoints++;
  }
}
if (capped) console.error("note:", capped);
if (!nRows) refuse("no rows in population.jsonl");
const thin = (pts) => { const k = Math.ceil(pts.length / LINE_POINTS); return k <= 1 ? pts : pts.filter((_, i) => i % k === 0 || i === pts.length - 1); };
let yMax = 1; for (const p of total) if (p[1] > yMax) yMax = p[1];
const xMax = Math.max(1e-9, total.at(-1)[0]);
const niceMax = (v) => { const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p) * p; };
const Y = niceMax(yMax);
const px = (x) => L + (x / xMax) * (W - L - R), py = (y) => H - B - (y / Y) * (H - T - B);
const colour = (hue, k) => (hue >= 0 ? `hsl(${hue},75%,58%)` : `hsl(${(k * 47) % 360},20%,70%)`); // legend creature colour on the page is hsl(hue, 75%, 58%)
const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join("");
const esc = (s) => clean(s).replace(/[&<>"']/g, "");
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui,sans-serif" font-size="16"><rect width="${W}" height="${H}" fill="#0b1a16"/>`;
for (let i = 0; i <= 5; i++) { const y = (Y * i) / 5; svg += `<line x1="${L}" x2="${W - R}" y1="${py(y)}" y2="${py(y)}" stroke="#25403a"/><text x="${L - 10}" y="${py(y) + 5}" fill="#9db8b0" text-anchor="end">${Math.round(y)}</text>`; }
const niceStep = (v) => { const p = 10 ** Math.floor(Math.log10(v)); return [1, 2, 5, 10].map((m) => m * p).find((m) => m >= v); };
const xStep = xMax > 240 ? niceStep(xMax / 20) : xMax > 48 ? 12 : xMax > 12 ? 4 : xMax > 4 ? 1 : 0.5; // at most about 20 ticks, whatever the range
for (let i = 0, x = 0; x <= xMax && i <= 25; i++, x = i * xStep) svg += `<line x1="${px(x)}" x2="${px(x)}" y1="${T}" y2="${H - B}" stroke="#182d28"/><text x="${px(x)}" y="${H - B + 24}" fill="#9db8b0" text-anchor="middle">${x}</text>`;
svg += `<text x="${(L + W - R) / 2}" y="${H - 16}" fill="#9db8b0" text-anchor="middle">simulated hours since the first row</text><text x="20" y="${H / 2}" fill="#9db8b0" transform="rotate(-90 20 ${H / 2})" text-anchor="middle">creatures alive</text>`;
svg += `<path d="${path(thin(total))}" fill="none" stroke="#e8f0ed" stroke-width="2" stroke-dasharray="6 4"/>`;
let k = 0, ly = T + 10;
svg += `<line x1="${W - R + 20}" x2="${W - R + 50}" y1="${ly}" y2="${ly}" stroke="#e8f0ed" stroke-width="2" stroke-dasharray="6 4"/><text x="${W - R + 58}" y="${ly + 5}" fill="#e8f0ed">total</text>`;
for (const s of [...lines.values()].sort((a, b) => b.max - a.max)) {
  const c = colour(s.hue, k++);
  svg += `<path d="${path(thin(s.pts))}" fill="none" stroke="${c}" stroke-width="2.5"/>`;
  ly += 26; svg += `<line x1="${W - R + 20}" x2="${W - R + 50}" y1="${ly}" y2="${ly}" stroke="${c}" stroke-width="3"/><text x="${W - R + 58}" y="${ly + 5}" fill="${c}">${esc(s.name)}</text>`;
}
svg += "</svg>\n";
writeFresh(out, svg);
console.log("wrote", out, nRows, "rows,", lines.size, "lineages");
if (opt.png === "1") { // Chrome renders in a private temporary folder; only the finished PNG is moved next to the SVG
  const png = pngOut, tmp = mkdtempSync(join(tmpdir(), "popchart-"));
  try {
    writeFileSync(join(tmp, "chart.svg"), svg, { flag: "wx" });
    execFileSync(CHROME, ["--headless", "--disable-gpu", `--window-size=${W},${H}`, `--screenshot=${join(tmp, "chart.png")}`, "file://" + join(tmp, "chart.svg")], { stdio: "ignore" });
    writeFresh(png, readFileSync(join(tmp, "chart.png")));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
  console.log("wrote", png);
}
