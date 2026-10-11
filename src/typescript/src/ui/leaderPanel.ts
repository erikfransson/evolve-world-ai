import type { Board, LeaderEntry, Leaders } from "../sim/leaderboard.ts";
import { rayAngleOffsets } from "../sim/sensors.ts";
import { durationText } from "./page.ts";
import { lineageColor } from "./lineagePanel.ts";
import { speciesSwitch } from "./speciesSwitch.ts";

const SIZE = 46; // mini drawing, CSS px

export interface BoardSpec {
  board: Board;
  title: string;
  value(v: number): string;
}

const count = (v: number): string => v.toLocaleString("en-US");
export const BOARD_SPECS: readonly BoardSpec[] = [
  { board: "age", title: "Longest-lived", value: durationText },
  { board: "children", title: "Most children", value: count },
  { board: "eaten", title: "Most food eaten", value: count },
  { board: "kills", title: "Most prey eaten", value: count },
];

// "2m 10s to 5m 3s", or "2m 10s to now" while alive.
export function lifeSpan(e: Pick<LeaderEntry, "from" | "to" | "alive">): string {
  return e.alive ? `${durationText(e.from)} to now` : `${durationText(e.from)} to ${durationText(e.to)}`;
}

// Pixels per world unit for the drawings of one card: its longest ray fills a drawing, so the fans compare.
export function fanScale(entries: readonly LeaderEntry[]): number {
  const longest = Math.max(1, ...entries.map((e) => e.plan.rayLength));
  return (SIZE / 2 - 1.5) / longest;
}

// SVG of a creature facing right with its vision fan: rays and fan area to scale, the body at least a few pixels.
export function creatureSvg(e: LeaderEntry, radius: number, scale: number): string {
  const c = SIZE / 2;
  const { raySpread, rayLength } = e.plan;
  const color = lineageColor(e.hue);
  const len = rayLength * scale;
  const at = (a: number): string => `${(c + len * Math.cos(a)).toFixed(2)} ${(c + len * Math.sin(a)).toFixed(2)}`;
  const rays = Array.from(rayAngleOffsets(e.plan), (a) => `M${c} ${c}L${at(a)}`).join("");
  const fan =
    raySpread >= 2 * Math.PI - 1e-9
      ? `<circle cx="${c}" cy="${c}" r="${len.toFixed(2)}" fill="${color}" fill-opacity="0.12"/>`
      : `<path d="M${c} ${c}L${at(-raySpread / 2)}A${len.toFixed(2)} ${len.toFixed(2)} 0 ${raySpread > Math.PI ? 1 : 0} 1 ${at(raySpread / 2)}Z" fill="${color}" fill-opacity="0.12"/>`;
  const body = Math.max(2.6, radius * scale);
  return `<svg viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" aria-hidden="true">${fan}<path d="${rays}" stroke="${color}" stroke-opacity="0.55" stroke-width="0.6" fill="none"/><circle cx="${c}" cy="${c}" r="${body.toFixed(2)}" fill="${color}"/></svg>`;
}

// The Records card: per measure the three best creatures of the run so far, living or dead, with a mini drawing, value and lifetime.
export class LeaderPanel {
  private readonly list: HTMLElement;
  private leaders: readonly Leaders[] = [];
  private species = 0;
  private readonly radius: number;

  constructor(root: HTMLElement, speciesNames: readonly string[], radius: number) {
    this.radius = radius;
    const body = root.querySelector<HTMLElement>(".ov-body")!;
    this.list = body.querySelector<HTMLElement>(".lead-list")!;
    speciesSwitch(body, "leadSpecies", speciesNames, (s) => { this.species = s; this.render(); });
  }

  set(leaders: readonly Leaders[]): void {
    this.leaders = leaders;
    this.render();
  }

  clear(): void {
    this.set([]);
  }

  private render(): void {
    const mine = this.leaders.filter((l) => l.species === this.species);
    const scale = fanScale(mine.flatMap((l) => l.entries));
    this.list.replaceChildren(
      ...BOARD_SPECS.flatMap((spec) => {
        const entries = mine.find((l) => l.board === spec.board)?.entries;
        if (!entries) return [];
        const li = document.createElement("li");
        li.className = "lead-board";
        const title = document.createElement("h3");
        title.textContent = spec.title;
        const row = document.createElement("div");
        row.className = "lead-row";
        for (const e of entries) {
          const cell = document.createElement("div");
          cell.className = "lead-cell";
          cell.title = `Creature #${e.id}, ${lifeSpan(e)}`;
          cell.innerHTML = creatureSvg(e, this.radius, scale);
          const value = document.createElement("b");
          value.textContent = spec.value(e.value);
          const span = document.createElement("small");
          span.textContent = lifeSpan(e);
          const text = document.createElement("span");
          text.append(value, span);
          cell.append(text);
          row.append(cell);
        }
        li.append(title, row);
        return [li];
      }),
    );
  }
}
