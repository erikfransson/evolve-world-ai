// Line chart of population per founder lineage over simulated time, from a world folder's population.jsonl. Writes an SVG (dependency-free) and, with png=1, a PNG through headless Chrome.
// Run: node tools/timelapse/popchart.mjs <world folder> [out=<file.svg>] [png=1]   View: open the SVG in a browser or image viewer.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const [dir, ...rest] = process.argv.slice(2);
if (!dir) { console.error("usage: node popchart.mjs <world folder> [out=file.svg] [png=1]"); process.exit(2); }
const opt = Object.fromEntries(rest.map((a) => a.split("=")));
const out = resolve(opt.out ?? join(dir, "population.svg"));
const W = 1600, H = 900, L = 90, R = 230, T = 40, B = 70; // chart size and margins in px
const CHROME = "/usr/bin/google-chrome";

const rows = readFileSync(join(dir, "population.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
if (!rows.length) { console.error("no rows"); process.exit(1); }
const t0 = rows[0].simSeconds ?? 0;
const hours = (r) => ((r.simSeconds ?? 0) - t0) / 3600;
const lines = new Map(); // name (or founder id) -> { name, hue, pts: [[hours, count]] }
rows.forEach((r, i) => {
  for (const l of r.lineages ?? []) {
    const key = l.name || "#" + l.founder; // the group's founder id is its lowest living one and changes as founders die, the name stays
    let s = lines.get(key);
    if (!s) lines.set(key, (s = { name: l.name || "#" + l.founder, hue: l.hue, pts: [] }));
    s.pts.push([i, hours(r), l.count]);
  }
});
const total = rows.map((r) => [hours(r), r.population]);
const xMax = Math.max(1e-9, hours(rows.at(-1))), yMax = Math.max(1, ...total.map((p) => p[1]));
const niceMax = (v) => { const p = 10 ** Math.floor(Math.log10(v)); return Math.ceil(v / p) * p; };
const Y = niceMax(yMax);
const px = (x) => L + (x / xMax) * (W - L - R), py = (y) => H - B - (y / Y) * (H - T - B);
const colour = (hue, k) => (hue >= 0 ? `hsl(${hue},75%,58%)` : `hsl(${(k * 47) % 360},20%,70%)`); // legend creature colour on the page is hsl(hue, 75%, 58%)
const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${px(p[0]).toFixed(1)},${py(p[1]).toFixed(1)}`).join("");
const esc = (s) => String(s).replace(/[&<>"]/g, "");
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui,sans-serif" font-size="16"><rect width="${W}" height="${H}" fill="#0b1a16"/>`;
for (let i = 0; i <= 5; i++) { const y = (Y * i) / 5; svg += `<line x1="${L}" x2="${W - R}" y1="${py(y)}" y2="${py(y)}" stroke="#25403a"/><text x="${L - 10}" y="${py(y) + 5}" fill="#9db8b0" text-anchor="end">${Math.round(y)}</text>`; }
const xStep = xMax > 48 ? 12 : xMax > 12 ? 4 : xMax > 4 ? 1 : 0.5;
for (let x = 0; x <= xMax; x += xStep) svg += `<line x1="${px(x)}" x2="${px(x)}" y1="${T}" y2="${H - B}" stroke="#182d28"/><text x="${px(x)}" y="${H - B + 24}" fill="#9db8b0" text-anchor="middle">${x}</text>`;
svg += `<text x="${(L + W - R) / 2}" y="${H - 16}" fill="#9db8b0" text-anchor="middle">simulated hours since the first row</text><text x="20" y="${H / 2}" fill="#9db8b0" transform="rotate(-90 20 ${H / 2})" text-anchor="middle">creatures alive</text>`;
svg += `<path d="${path(total)}" fill="none" stroke="#e8f0ed" stroke-width="2" stroke-dasharray="6 4"/>`;
let k = 0, ly = T + 10;
svg += `<line x1="${W - R + 20}" x2="${W - R + 50}" y1="${ly}" y2="${ly}" stroke="#e8f0ed" stroke-width="2" stroke-dasharray="6 4"/><text x="${W - R + 58}" y="${ly + 5}" fill="#e8f0ed">total</text>`;
for (const s of [...lines.values()].sort((a, b) => Math.max(...b.pts.map((p) => p[2])) - Math.max(...a.pts.map((p) => p[2])))) {
  const c = colour(s.hue, k++);
  svg += `<path d="${path(s.pts.map((p) => [p[1], p[2]]))}" fill="none" stroke="${c}" stroke-width="2.5"/>`;
  ly += 26; svg += `<line x1="${W - R + 20}" x2="${W - R + 50}" y1="${ly}" y2="${ly}" stroke="${c}" stroke-width="3"/><text x="${W - R + 58}" y="${ly + 5}" fill="${c}">${esc(s.name)}</text>`;
}
svg += "</svg>\n";
writeFileSync(out, svg);
console.log("wrote", out, rows.length, "rows,", lines.size, "lineages");
if (opt.png === "1") {
  const png = out.replace(/\.svg$/, "") + ".png";
  execFileSync(CHROME, ["--headless", "--no-sandbox", "--disable-gpu", `--window-size=${W},${H}`, `--screenshot=${png}`, "file://" + out], { stdio: "ignore" });
  console.log("wrote", png);
}
