import type { Lineage } from "../sim/ecosystem.ts";
import { LINEAGE_STRIDE, LINEAGE_TOP } from "../worker/ecoProtocol.ts";
import { fitCanvas, graphFont } from "./canvas.ts";
import { creatureStyle } from "./ecoScene.ts";
import { formatDuration } from "./populationGraph.ts";

const OTHERS_COLOR = "#5f7a6c";
const AXIS_COLOR = "rgba(143, 174, 159, 0.5)";
const TEXT_COLOR = "#8fae9f";
const PAD = { left: 40, right: 8, top: 7, bottom: 19 }; // CSS px

export const lineageColor = (hue: number): string => creatureStyle(hue, 0);

export interface LineageRow {
  founder: number; // -1 for the creatures outside the listed lineages
  label: string;
  origin: string; // "pool", "random" or ""
  share: number; // 0 to 1
  count: number;
  color: string;
}

// The listed lineages and one row for everyone else, as shares of population. names: founders a visitor named (Live World).
export function lineageRows(lineages: readonly Lineage[], population: number, names?: ReadonlyMap<number, string>): LineageRow[] {
  const total = Math.max(1, population);
  const rows: LineageRow[] = lineages.map((l) => ({
    founder: l.founder,
    label: names?.get(l.founder) ?? `#${l.founder}`,
    origin: names?.has(l.founder) ? "added" : l.pool ? "pool" : "random",
    share: l.count / total,
    count: l.count,
    color: lineageColor(l.hue),
  }));
  const listed = lineages.reduce((n, l) => n + l.count, 0);
  if (population > listed) rows.push({ founder: -1, label: "others", origin: "", share: (population - listed) / total, count: population - listed, color: OTHERS_COLOR });
  return rows;
}

export interface LineageBand {
  founder: number;
  color: string;
}

// History samples as stacked bands: bands in founder-id order, with `lower` and `upper` the share boundaries per sample.
export interface Stack {
  times: number[];
  bands: (LineageBand & { lower: number[]; upper: number[] })[]; // the last band is everyone else (founder -1)
}

// Turns lineage history (LINEAGE_STRIDE numbers per sample, see ecoProtocol) into stacked shares. A founder outside the top at a sample counts as others there.
export function stackHistory(h: Float64Array): Stack {
  const n = Math.floor(h.length / LINEAGE_STRIDE);
  const hues = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < LINEAGE_TOP; k++) {
      const at = i * LINEAGE_STRIDE + 2 + 3 * k;
      const id = h[at]!;
      if (id >= 0) hues.set(id, h[at + 2]!);
    }
  }
  const ids = [...hues.keys()].sort((a, b) => a - b);
  const index = new Map(ids.map((id, j) => [id, j]));
  const stack: Stack = {
    times: [],
    bands: [...ids.map((id) => ({ founder: id, color: lineageColor(hues.get(id)!), lower: [] as number[], upper: [] as number[] })), { founder: -1, color: OTHERS_COLOR, lower: [] as number[], upper: [] as number[] }],
  };
  const counts = new Float64Array(ids.length + 1);
  for (let i = 0; i < n; i++) {
    const base = i * LINEAGE_STRIDE;
    counts.fill(0);
    let total = h[base + 1]!;
    counts[ids.length] = total;
    for (let k = 0; k < LINEAGE_TOP; k++) {
      const id = h[base + 2 + 3 * k]!;
      if (id < 0) continue;
      const c = h[base + 3 + 3 * k]!;
      counts[index.get(id)!] = c;
      total += c;
    }
    stack.times.push(h[base]!);
    let sum = 0;
    for (let j = 0; j < counts.length; j++) {
      const band = stack.bands[j]!;
      band.lower.push(total > 0 ? sum / total : 0);
      sum += counts[j]!;
      band.upper.push(total > 0 ? sum / total : 0);
    }
  }
  return stack;
}

// The Lineages card: stacked bar of current shares, a legend that picks a lineage to highlight, and the shares over time.
export class LineagePanel {
  private readonly bar: HTMLElement;
  private readonly list: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly clear: HTMLButtonElement;
  private readonly onPick: (founder: number | null) => void;
  private stack: Stack = { times: [], bands: [] };
  private picked: number | null = null;
  private pending = false;
  private signature = "";

  constructor(root: HTMLElement, onPick: (founder: number | null) => void) {
    this.bar = root.querySelector<HTMLElement>(".lin-bar")!;
    this.list = root.querySelector<HTMLElement>(".lin-list")!;
    this.canvas = root.querySelector<HTMLCanvasElement>(".lin-graph")!;
    this.clear = root.querySelector<HTMLButtonElement>(".lin-clear")!;
    this.onPick = onPick;
    this.bar.hidden = true; // nothing to show until data exists
    this.clear.onclick = () => this.pick(null);
    this.list.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-founder]");
      if (row) this.pick(Number(row.dataset.founder));
    });
    this.bar.addEventListener("click", (e) => {
      const seg = (e.target as HTMLElement).closest<HTMLElement>("[data-founder]");
      if (seg) this.pick(Number(seg.dataset.founder));
    });
    new ResizeObserver(() => this.invalidate()).observe(this.canvas);
  }

  // Selecting the highlighted lineage again clears it; others (-1) cannot be highlighted.
  pick(founder: number | null): void {
    if (founder === -1) return;
    this.setHighlight(founder === this.picked ? null : founder);
    this.onPick(this.picked);
  }

  highlight(): number | null {
    return this.picked;
  }

  setHighlight(founder: number | null): void {
    this.picked = founder;
    this.clear.hidden = founder === null;
    this.signature = ""; // repaint the pressed state
    for (const e of this.root().querySelectorAll<HTMLElement>("[data-founder]")) this.markPressed(e);
  }

  private root(): HTMLElement {
    return this.list.parentElement!;
  }

  private markPressed(e: HTMLElement): void {
    const on = this.picked !== null && Number(e.dataset.founder) === this.picked;
    e.setAttribute("aria-pressed", String(on));
    e.classList.toggle("on", on);
  }

  setLineages(lineages: readonly Lineage[], population: number, names?: ReadonlyMap<number, string>): void {
    const rows = lineageRows(lineages, population, names);
    const signature = rows.map((r) => `${r.founder}:${r.count}:${r.label}`).join(",") + `|${this.picked}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.bar.hidden = rows.length === 0;
    const pct = (s: number): string => (s >= 0.995 || s < 0.001 ? `${Math.round(s * 100)}%` : s < 0.1 ? `${(s * 100).toFixed(1)}%` : `${Math.round(s * 100)}%`);
    this.bar.replaceChildren(
      ...rows.map((r) => {
        const seg = document.createElement("span");
        seg.style.flex = `${r.share} 1 0`;
        seg.style.background = r.color;
        seg.title = r.founder < 0 ? `Everyone else: ${pct(r.share)}` : `Founder ${r.label}: ${pct(r.share)}`;
        if (r.founder >= 0) seg.dataset.founder = String(r.founder);
        return seg;
      }),
    );
    this.list.replaceChildren(
      ...rows.map((r) => {
        const li = document.createElement("li");
        const tag = r.founder < 0 ? "div" : "button";
        const row = document.createElement(tag);
        row.className = "lin-row";
        if (r.founder >= 0) {
          row.dataset.founder = String(r.founder);
          (row as HTMLButtonElement).type = "button";
          row.title = "Highlight this lineage in the world";
        }
        const sw = document.createElement("i");
        sw.style.background = r.color;
        const name = document.createElement("span");
        name.className = "lin-name";
        name.textContent = r.label;
        const origin = document.createElement("span");
        origin.className = "lin-origin";
        origin.textContent = r.origin;
        const share = document.createElement("span");
        share.className = "lin-share";
        share.textContent = pct(r.share);
        const count = document.createElement("span");
        count.className = "lin-count";
        count.textContent = r.count.toLocaleString("en-US");
        row.append(sw, name, origin, share, count);
        li.append(row);
        if (r.founder >= 0) this.markPressed(row);
        return li;
      }),
    );
  }

  setHistory(h: Float64Array): void {
    this.stack = stackHistory(h);
    this.invalidate();
  }

  reset(): void {
    this.signature = "";
    this.bar.replaceChildren();
    this.bar.hidden = true;
    this.list.replaceChildren();
    this.stack = { times: [], bands: [] };
    this.setHighlight(null);
    this.invalidate();
  }

  private invalidate(): void {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      this.draw();
    });
  }

  private draw(): void {
    const dpr = fitCanvas(this.canvas);
    const ctx = this.canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.canvas.clientWidth, this.canvas.clientHeight);
    const w = this.canvas.clientWidth - PAD.left - PAD.right;
    const h = this.canvas.clientHeight - PAD.top - PAD.bottom;
    if (w <= 0 || h <= 0) return;
    const { times, bands } = this.stack;
    const end = Math.max(1, times[times.length - 1] ?? 1);
    const px = (t: number): number => PAD.left + (t / end) * w;
    const py = (share: number): number => PAD.top + h - share * h;
    ctx.font = graphFont();
    if (times.length === 0) {
      ctx.fillStyle = TEXT_COLOR;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("Waiting for data", PAD.left + w / 2, PAD.top + h / 2);
      return;
    }
    for (const band of bands) {
      if (band.upper.every((u, i) => u === band.lower[i])) continue;
      ctx.fillStyle = band.color;
      ctx.globalAlpha = this.picked === null || band.founder === this.picked ? 1 : 0.3;
      ctx.beginPath();
      times.forEach((t, i) => (i === 0 ? ctx.moveTo(px(t), py(band.upper[i]!)) : ctx.lineTo(px(t), py(band.upper[i]!))));
      for (let i = times.length - 1; i >= 0; i--) ctx.lineTo(px(times[i]!), py(band.lower[i]!));
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.strokeStyle = AXIS_COLOR;
    ctx.strokeRect(PAD.left, PAD.top, w, h);
    ctx.fillStyle = TEXT_COLOR;
    ctx.textBaseline = "top";
    ctx.textAlign = "right";
    ctx.fillText("100%", PAD.left - 4, PAD.top - 3);
    ctx.fillText("0%", PAD.left - 4, PAD.top + h - 7);
    ctx.textAlign = "left";
    ctx.fillText("0 s", PAD.left, PAD.top + h + 3);
    ctx.textAlign = "right";
    ctx.fillText(formatDuration(end), PAD.left + w, PAD.top + h + 3);
  }
}
