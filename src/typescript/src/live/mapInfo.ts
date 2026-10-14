import { SWATCHES } from "../ui/terrainLegend.ts";
import { MAX_REGIONS } from "./protocol.ts";
import { mapSpec } from "../sim/maps/index.ts";
import type { Hello, WireMap, WireRegion } from "./protocol.ts";

// The information section below the world: legend, ground shares, regions (once a map has them) and the world's facts.
// Everything from the server goes in through textContent; the swatches are the page's own markup.

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const share = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const rel = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 0);
const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[^\x20-\x7e]/g, "").slice(0, max) : "");

// A map from the wire with every share 0 to 1, at most MAX_REGIONS short regions and a name only when it is a known map; all-normal ground when missing.
export function cleanMap(m: unknown): WireMap {
  const g = isObj(m) && isObj(m.ground) ? m.ground : null;
  const ground = g ? { normal: share(g.normal), mud: share(g.mud), firm: share(g.firm), rock: share(g.rock) } : { normal: 1, mud: 0, firm: 0, rock: 0 };
  const regions = isObj(m) && Array.isArray(m.regions) ? m.regions.slice(0, MAX_REGIONS).filter(isObj).map((r): WireRegion => ({ name: text(r.name, 40), food: rel(r.food), poison: rel(r.poison), ground: text(r.ground, 60), role: text(r.role, 60) })).filter((r) => r.name) : [];
  const name = isObj(m) && typeof m.name === "string" && mapSpec(m.name) ? m.name : undefined;
  return { ...(name ? { name } : {}), ground, regions };
}

const CREATURE = `<clipPath id="infoSwClip"><circle cx="10" cy="10" r="8" /></clipPath><circle cx="10" cy="10" r="8" fill="rgba(15, 23, 20, 0.85)" /><rect x="0" y="8.4" width="20" height="12" fill="hsl(200, 75%, 58%)" clip-path="url(#infoSwClip)" /><circle cx="10" cy="10" r="8" fill="none" stroke="hsl(200, 75%, 58%)" stroke-width="1.6" />`;
const ROWS: { key: keyof WireMap["ground"] | null; swatch: string; label: string; note: string }[] = [
  { key: null, swatch: CREATURE, label: "Creature", note: "the fill is its energy, the colour its family" },
  { key: null, swatch: `<circle cx="10" cy="10" r="8" fill="none" stroke="#eef5f1" stroke-width="1.6" />`, label: "Selected creature", note: "with its rays when zoomed in" },
  { key: null, swatch: `<circle cx="10" cy="10" r="5" fill="#4ade80" />`, label: "Food", note: "regrows, less in winter" },
  { key: null, swatch: `<circle cx="10" cy="10" r="5" fill="#e040fb" />`, label: "Poison", note: "one bite kills" },
  { key: "rock", swatch: SWATCHES.rock, label: "Rock", note: "creatures bounce off, rays stop" },
  { key: "mud", swatch: SWATCHES.slow, label: "Mud", note: "half speed" },
  { key: "firm", swatch: SWATCHES.fast, label: "Firm ground", note: "175% speed" },
];

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", content = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (content) e.textContent = content;
  return e;
};
const pct = (v: number): string => (v > 0 && v < 0.01 ? "<1%" : `${Math.round(v * 100)}%`);
const nf = new Intl.NumberFormat("en-US");
const weight = (v: number): string => (v >= 1 ? v.toFixed(1) : String(Math.round(v * 100) / 100)); // 1.6, 0.65, 0.15

export function renderMapInfo(root: HTMLElement, hello: Hello): void {
  const map = hello.map;
  const g = map.ground;
  const $ = (id: string): HTMLElement => root.querySelector<HTMLElement>(`#${id}`)!;
  root.hidden = false; // hidden until the first hello, so no empty headings show

  const legend = $("infoLegend");
  legend.replaceChildren(
    ...ROWS.filter((r) => r.key === null || g[r.key] > 0).map((r) => {
      const li = el("li");
      li.innerHTML = `<svg viewBox="0 0 20 20" aria-hidden="true">${r.swatch}</svg>`; // the page's own constant markup
      const t = el("span");
      t.append(el("b", "", r.label), el("span", "info-dim", ` · ${r.note}`));
      li.append(t);
      return li;
    }),
  );
  const flat = g.mud + g.firm + g.rock === 0;
  $("infoLegendNote").textContent = flat ? "This world has no rock, mud or firm ground yet: every spot is plain ground." : "";

  const shares = $("infoShares");
  const kinds: [keyof WireMap["ground"], string][] = [["normal", "Normal"], ["mud", "Mud"], ["firm", "Firm"], ["rock", "Rock"]];
  shares.replaceChildren(
    ...kinds.map(([k, label]) => {
      const d = el("div", `share share-${k}`);
      d.append(el("b", "", pct(g[k])), el("span", "", label));
      return d;
    }),
  );
  const bar = $("infoBar");
  bar.replaceChildren(
    ...kinds.filter(([k]) => g[k] > 0).map(([k, label]) => {
      const s = el("span", `bar-${k}`);
      s.style.flex = `${g[k]} 1 0`;
      s.title = `${label}: ${pct(g[k])}`;
      return s;
    }),
  );

  // Regions: a table once the map has named ones; the current world is one open plain.
  const regions = $("infoRegions");
  if (map.regions.length === 0) {
    regions.replaceChildren(el("p", "info-note", "One open world: food and poison grow everywhere at the same rate (1.0), with no regions of their own."));
  } else {
    const table = el("table", "info-table");
    const head = el("tr");
    for (const h of ["Region", "Food", "Poison", "Ground", "Role"]) head.append(el("th", "", h));
    table.append(el("thead"), el("tbody"));
    table.tHead!.append(head);
    for (const r of map.regions) {
      const tr = el("tr");
      tr.append(el("td", "", r.name), el("td", "num", weight(r.food)), el("td", "num", r.poison > 0 ? weight(r.poison) : "no poison"), el("td", "", r.ground), el("td", "", r.role));
      table.tBodies[0]!.append(tr);
    }
    const wrap = el("div", "info-table-wrap");
    wrap.append(table);
    regions.replaceChildren(wrap, el("p", "info-note", "Food and poison: how much grows there and how much it holds, against 1.0 for plain food."));
  }

  const s = hello.summary;
  const facts: [string, string][] = [
    ["Size", `${nf.format(hello.world.width)} × ${nf.format(hello.world.height)} units`],
    ["Started with", s.initialPopulation === 0 && s.seedCopies ? `${s.seedCopies} of each starter founder` : `${nf.format(s.initialPopulation)} creatures`],
    ["Room for", `${nf.format(s.maxPopulation)} creatures`],
    ["Bumps", s.collisionDamage ? "cost energy, and a kill takes the loser's energy" : "harmless"],
    ["Seasons", s.seasons ? "on: lean winters with less food" : "off"],
  ];
  $("infoWorld").replaceChildren(
    ...facts.map(([k, v]) => {
      const d = el("div");
      d.append(el("dt", "", k), el("dd", "", v));
      return d;
    }),
  );
}
