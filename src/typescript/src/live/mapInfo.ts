import { MAX_REGIONS } from "./protocol.ts";
import { POISON_LETHAL } from "../sim/config.ts";
import { FAST_FACTOR, SLOW_FACTOR } from "../sim/terrain.ts";
import { SWATCHES } from "../ui/terrainLegend.ts";
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
  const version = name && isObj(m) && typeof m.version === "string" && /^[0-9a-f]{8}-[0-9]{1,6}$/.test(m.version) ? m.version : undefined;
  return { ...(name ? { name } : {}), ...(version ? { version } : {}), ground, regions };
}


// Item and creature swatches (the page's own constant markup), drawn over a patch of plain ground like the map.
const CREATURE = (hue: number, fill: number, id: string, dim = false): string =>
  `<clipPath id="${id}"><circle cx="0" cy="0" r="6" /></clipPath><g opacity="${dim ? 0.35 : 1}"><circle r="6" fill="rgba(15, 23, 20, 0.85)" /><rect x="-7" y="${6 - 12 * fill}" width="14" height="14" fill="hsl(${hue}, 75%, 58%)" clip-path="url(#${id})" /><circle r="6" fill="none" stroke="hsl(${hue}, 75%, 58%)" stroke-width="1.4" /></g>`;
const ITEM_SWATCHES = {
  creature: `<g transform="translate(16 16)">${CREATURE(200, 0.35, "lgA")}</g><g transform="translate(33 16)">${CREATURE(200, 0.85, "lgB")}</g>`,
  selected: `<g transform="translate(24 16)">${CREATURE(30, 0.6, "lgC")}<circle r="10" fill="none" stroke="#eef5f1" stroke-width="1.5" /><path d="M8 -4 L20 -9 M10 0 L22 0 M8 4 L20 9" stroke="#eef5f1" stroke-opacity="0.5" stroke-width="1" /></g>`,
  family: `<g transform="translate(12 12)">${CREATURE(140, 0.7, "lgD")}</g><g transform="translate(26 21)">${CREATURE(140, 0.5, "lgE")}</g><g transform="translate(39 11)">${CREATURE(280, 0.6, "lgF", true)}</g>`,
  birth: `<g transform="translate(24 16)"><circle r="11" fill="none" stroke="hsl(50, 90%, 72%)" stroke-opacity="0.55" stroke-width="1.2" /><circle r="7" fill="none" stroke="hsl(50, 90%, 72%)" stroke-width="1.6" /><g transform="scale(0.6)">${CREATURE(50, 0.5, "lgG")}</g></g>`,
  food: `<circle cx="14" cy="12" r="2.6" fill="#4ade80" /><circle cx="27" cy="20" r="2.6" fill="#4ade80" /><circle cx="36" cy="10" r="2.6" fill="#4ade80" />`,
  poison: `<circle cx="16" cy="19" r="2.6" fill="#e040fb" /><circle cx="32" cy="12" r="2.6" fill="#e040fb" />`,
};

// A 20 x 20 drawn icon (ui/terrainLegend.ts) in the middle of a 48 x 32 tile, until a swatch cut from the built map replaces it.
const icon = (inner: string): string => `<g transform="translate(14 6)">${inner}</g>`;

type Kind = "rock" | "mud" | "firm" | "rich" | "poison" | "dry";
interface Row {
  group: string;
  label: string;
  note: (s: Hello["summary"]) => string;
  key?: keyof WireMap["ground"]; // shown only while the world has some of it
  kind?: Kind; // a swatch cut from the map once it is built (live/mapLegend.ts); region rows show only then
  svg?: string;
}
const ROWS: Row[] = [
  { group: "Ground", label: "Rock", key: "rock", kind: "rock", svg: icon(SWATCHES.rock), note: () => "creatures bounce off it, and their rays stop at it" },
  { group: "Ground", label: "Mud", key: "mud", kind: "mud", svg: icon(SWATCHES.slow), note: () => `slows a creature to half speed (×${SLOW_FACTOR})` },
  { group: "Ground", label: "Firm ground", key: "firm", kind: "firm", svg: icon(SWATCHES.fast), note: () => `a creature runs faster here (×${FAST_FACTOR})` },
  { group: "Regions", label: "Rich ground", kind: "rich", note: () => "the green wash: more food grows here, and more of it stays" },
  { group: "Regions", label: "Poisoned ground", kind: "poison", note: () => "the purple wash: poison grows here" },
  { group: "Regions", label: "Poor ground", kind: "dry", note: () => "the dry wash: little food grows here" },
  { group: "Items", label: "Food", svg: ITEM_SWATCHES.food, note: (s) => `${s.foodEnergy !== undefined ? `+${Math.round(s.foodEnergy)} energy a bite; ` : ""}regrows, less in winter` },
  { group: "Items", label: "Poison", svg: ITEM_SWATCHES.poison, note: (s) => (s.poisonDamage === undefined || s.poisonDamage >= POISON_LETHAL ? "one bite kills" : s.poisonDamage === 0 ? "harmless here" : `−${Math.round(s.poisonDamage)} energy a bite`) },
  { group: "Creatures", label: "Creature", svg: ITEM_SWATCHES.creature, note: () => "the fill is its energy, the colour its family" },
  { group: "Creatures", label: "Selected", svg: ITEM_SWATCHES.selected, note: () => "a white ring, and its rays when zoomed in" },
  { group: "Creatures", label: "Family lit", svg: ITEM_SWATCHES.family, note: () => "a lineage picked in the list: the rest of the world dims" },
  { group: "Creatures", label: "Birth", svg: ITEM_SWATCHES.birth, note: () => "a ring where a child is born" },
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
  const items: HTMLElement[] = [];
  let group = "";
  for (const r of ROWS) {
    if (r.key && !(g[r.key] > 0)) continue;
    if (r.group !== group) {
      group = r.group;
      items.push(el("li", "lg-head", group));
    }
    const li = el("li", "lg-row");
    const tile = el("span", "lg-tile");
    if (r.svg) tile.innerHTML = `<svg viewBox="0 0 48 32" aria-hidden="true">${r.svg}</svg>`; // the page's own constant markup
    if (r.kind) {
      li.dataset.kind = r.kind;
      if (!r.key) li.hidden = true; // a region row shows once the map has it (paintMapLegend)
    }
    const t = el("span");
    t.append(el("b", "", r.label), el("span", "info-dim", ` · ${r.note(hello.summary)}`));
    li.append(tile, t);
    items.push(li);
  }
  legend.replaceChildren(...items);
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
