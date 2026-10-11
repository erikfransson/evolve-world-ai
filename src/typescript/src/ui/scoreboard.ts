import type { EngineConfig } from "../sim/config.ts";

// Local top 3 per preset, kept in localStorage. Everything works without storage, the board then lives until the page closes.
export const TOP = 3;

// Creature and brain of a scored run, compact: angles in degrees.
export interface EntrySettings {
  seed: number;
  rays: number;
  spread: number;
  length: number;
  hidden: number[];
  memory: number;
}

export interface Entry {
  run: string; // one entry per run: later scores of the same run replace it
  score: number; // seconds
  date: string; // YYYY-MM-DD
  settings: EntrySettings; // short summary of the creature and brain, and all that entries saved before `config` existed have
  config?: string; // the run's full settings as the Copy button writes them, loaded through the Paste path
  note?: string; // extra context shown with the score, e.g. peak population
}

export const settingsOf = (c: Pick<EngineConfig, "seed" | "creature" | "brain">): EntrySettings => ({
  seed: c.seed,
  rays: c.creature.rayCount,
  spread: Math.round((c.creature.raySpread * 180) / Math.PI),
  length: c.creature.rayLength,
  hidden: [...c.brain.hiddenLayers],
  memory: c.brain.memory,
});

// A copy of the config with the entry's creature and brain; the world and everything else stays.
export function withSettings<C extends Pick<EngineConfig, "seed" | "creature" | "brain">>(c: C, s: EntrySettings): C {
  const out = structuredClone(c);
  out.seed = s.seed;
  out.creature.rayCount = s.rays;
  out.creature.raySpread = (s.spread * Math.PI) / 180;
  out.creature.rayLength = s.length;
  out.brain.hiddenLayers = [...s.hidden];
  out.brain.memory = s.memory;
  return out;
}

export function describeSettings(s: EntrySettings): string {
  const mem = s.memory === 0 ? "no memory" : `memory ${s.memory}`;
  return `${s.rays} ${s.rays === 1 ? "ray" : "rays"} · ${s.spread}° · range ${s.length} · hidden ${s.hidden.join("+")} · ${mem} · seed ${s.seed}`;
}

// Sorted best first and cut to TOP. A score of a run already on the list replaces the old one only when higher.
export function insertEntry(list: readonly Entry[], e: Entry): Entry[] {
  const old = list.find((x) => x.run === e.run);
  if (old && old.score >= e.score) return list.slice(0, TOP);
  return [...list.filter((x) => x.run !== e.run), e].sort((a, b) => b.score - a.score).slice(0, TOP);
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function validSettings(s: unknown): s is EntrySettings {
  if (typeof s !== "object" || s === null) return false;
  const o = s as Record<string, unknown>;
  return isNum(o.seed) && isNum(o.rays) && isNum(o.spread) && isNum(o.length) && isNum(o.memory) && Array.isArray(o.hidden) && o.hidden.length > 0 && o.hidden.every(isNum);
}

function validEntry(e: unknown): e is Entry {
  if (typeof e !== "object" || e === null) return false;
  const o = e as Record<string, unknown>;
  return typeof o.run === "string" && isNum(o.score) && typeof o.date === "string" && validSettings(o.settings) && (o.config === undefined || typeof o.config === "string") && (o.note === undefined || typeof o.note === "string");
}

type Store = Pick<Storage, "getItem" | "setItem">;

export function browserStorage(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null; // blocked, e.g. private windows or disabled site data
  }
}

export class Scoreboard {
  private boards: Record<string, Entry[]> = Object.create(null); // no prototype, so a preset id like "constructor" finds nothing
  private readonly key: string;

  private readonly storage: Store | null;

  constructor(mode: string, storage: Store | null = browserStorage()) {
    this.storage = storage;
    this.key = `evolve.scores.v1.${mode}`;
    try {
      const raw: unknown = JSON.parse(this.storage?.getItem(this.key) ?? "{}");
      if (typeof raw === "object" && raw !== null) {
        for (const [id, list] of Object.entries(raw)) if (Array.isArray(list)) this.boards[id] = list.filter(validEntry).slice(0, TOP);
      }
    } catch {
      this.boards = Object.create(null);
    }
  }

  top(preset: string): readonly Entry[] {
    return this.boards[preset] ?? [];
  }

  // True when the board changed.
  submit(preset: string, e: Entry): boolean {
    const before = this.top(preset);
    const after = insertEntry(before, e);
    if (after.length === before.length && after.every((x, i) => x === before[i])) return false;
    this.boards[preset] = after;
    try {
      this.storage?.setItem(this.key, JSON.stringify(this.boards));
    } catch {
      // quota or blocked storage: keep the in-memory board
    }
    return true;
  }
}

export const today = (): string => new Date().toISOString().slice(0, 10);
