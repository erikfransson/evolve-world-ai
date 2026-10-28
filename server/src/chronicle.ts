import type { EcoCreature, Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { Leaderboard, boardValue } from "../../src/typescript/src/sim/leaderboard.ts";
import { HISTORY_FIELDS, LINEAGE_FIELDS, MAX_GROUP_FOUNDERS, LINEAGE_TOP, MAX_HISTORY, MAX_LINEAGE_HISTORY, MAX_RECORDS, RECORD_BOARDS } from "../../src/typescript/src/live/protocol.ts";
import type { History, RecordBoard, Stats, WireLineage, WireRecord } from "../../src/typescript/src/live/protocol.ts";
import { wireName } from "../../src/typescript/src/live/add.ts";

export const SAMPLE_EVERY_S = 20; // simulated seconds between population samples: MAX_HISTORY of them span 6 simulated hours
export const LINEAGE_EVERY_S = 120; // and between lineage samples, the same 6 hours

interface Group {
  founder: number; // the lowest founder id in the group, so its colour and row stay put as families come and go
  hue: number;
  pool: boolean;
  count: number;
  name: string;
  starter: boolean;
  others: number[]; // the group's other founders
}

// wireName by raw engine name: a pure function of the string, and the family rows ask for it every second. Bounded by clearing when full.
const parsedNames = new Map<string, { name: string; starter: boolean; key: string }>();
const MAX_PARSED_NAMES = 2048;
function parsedName(raw: string): { name: string; starter: boolean; key: string } {
  let p = parsedNames.get(raw);
  if (!p) {
    if (parsedNames.size >= MAX_PARSED_NAMES) parsedNames.clear();
    const { name, starter } = wireName(raw);
    p = { name, starter, key: name ? `${starter ? "*" : ""}${name.toLowerCase()}` : "" }; // the add rule's case: one name, one family on the list
    parsedNames.set(raw, p);
  }
  return p;
}

// The k largest families, with every family of the same visible name (the 10 seeded copies of a starter, a visitor's 1 to 10 copies)
// counted as one; unnamed families stand alone. From the lineage table's kept counts, O(living families) per call.
export function namedTop(eco: Ecosystem, k: number): Group[] {
  const groups = new Map<string, Group>();
  eco.lineages.forEachLiving((founder, count, hue, pool) => {
    const { name, starter, key: nameKey } = parsedName(eco.lineageName(founder));
    const key = name ? nameKey : `#${founder}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { founder, hue, pool, count, name, starter, others: [] });
    else {
      g.count += count;
      if (founder < g.founder) {
        g.others.push(g.founder);
        Object.assign(g, { founder, hue, pool, name });
      } else g.others.push(founder);
    }
  });
  return [...groups.values()].sort((a, b) => b.count - a.count || a.founder - b.founder).slice(0, k);
}

// The world's history and records as the page shows them: population and lineage samples in bounded rings, the best few creatures
// per board since the server started (dead ones included), and the best living ones. Fed about once a second from the stats loop.
export class Chronicle {
  private samples: number[] = []; // HISTORY_FIELDS per sample, oldest first
  private lineage: number[] = []; // LINEAGE_FIELDS per sample
  private nextSample = -Infinity;
  private nextLineage = -Infinity;
  private board = new Leaderboard(MAX_RECORDS);
  private historyJson: string | null = null;
  private watched: Ecosystem | null = null;

  // A new world (reseed or load): history and records start over.
  reset(eco: Ecosystem): void {
    this.samples = [];
    this.lineage = [];
    this.nextSample = this.nextLineage = -Infinity;
    this.board = new Leaderboard(MAX_RECORDS);
    this.historyJson = null;
    this.watched = eco;
    eco.onDeath = (m) => this.offer(eco, m, false);
  }

  private offer(eco: Ecosystem, m: EcoCreature, alive: boolean): void {
    const dt = eco.config.dt;
    const now = eco.tick * dt;
    const build = () => ({ id: m.id, species: 0, hue: m.hue, from: m.birthTick * dt, plan: { ...m.creature.plan, hiddenLayers: m.creature.plan.hiddenLayers.slice() } });
    for (const board of RECORD_BOARDS) this.board.offer(board, 0, m.id, boardValue(m, board, dt), now, alive, build);
  }

  // Adds what is due to the stats message: a sample when one was taken, and the lineages, best living and (with records) the records.
  // viewed false (no viewer connected): only the history and lineage samples run. The lineage rows, best, depth and the living
  // records wait for the next viewed call (values only grow, and deaths offer themselves through onDeath).
  observe(eco: Ecosystem, stats: Stats, records: boolean, viewed = true): void {
    if (this.watched !== eco) this.reset(eco);
    const t = eco.tick * eco.config.dt;
    const top = viewed || t >= this.nextLineage ? namedTop(eco, LINEAGE_TOP) : []; // the family table is the dearest part of an idle pass
    // An extinct world's clock stops (no ticks), so its 0 is sampled at once, or the graph would end on the last living count.
    const diedOut = eco.extinct && this.samples.length > 0 && this.samples[this.samples.length - 2] !== 0;
    if (t >= this.nextSample || diedOut) {
      this.nextSample = t + SAMPLE_EVERY_S;
      stats.sample = [Math.round(t), eco.population, eco.food];
      this.samples.push(...stats.sample);
      if (this.samples.length > MAX_HISTORY * HISTORY_FIELDS) this.samples.splice(0, HISTORY_FIELDS);
      this.historyJson = null;
    }
    if (t >= this.nextLineage) {
      this.nextLineage = t + LINEAGE_EVERY_S;
      let inTop = 0;
      for (const l of top) inTop += l.count;
      const s = [Math.round(t), eco.population - inTop];
      for (let k = 0; k < LINEAGE_TOP; k++) {
        const l = top[k];
        s.push(l ? l.founder : -1, l ? l.count : 0, l ? Math.round(l.hue) : 0);
      }
      stats.lineageSample = s;
      this.lineage.push(...s);
      if (this.lineage.length > MAX_LINEAGE_HISTORY * LINEAGE_FIELDS) this.lineage.splice(0, LINEAGE_FIELDS);
      this.historyJson = null;
    }
    if (!viewed) return;
    stats.lineages = top.map((l): WireLineage => ({ founder: l.founder, hue: Math.round(l.hue), pool: l.pool, count: l.count, ...(l.name ? { name: l.name, ...(l.starter ? { starter: true } : {}) } : {}), ...(l.others.length ? { founders: l.others.sort((a, b) => a - b).slice(0, MAX_GROUP_FOUNDERS) } : {}) }));
    let oldest: EcoCreature | null = null;
    let parent: EcoCreature | null = null;
    let killer: EcoCreature | null = null;
    let kills = 0;
    let depth = 0;
    // One pass: a creature is offered only when it could enter or update a list (Leaderboard.floor), the rest only count for best and depth.
    const members = eco.members;
    const dt = eco.config.dt;
    const floors = RECORD_BOARDS.map((b) => this.board.floor(b, 0));
    for (let i = 0; i < members.length; i++) {
      const m = members[i]!;
      for (let b = 0; b < RECORD_BOARDS.length; b++) {
        const v = boardValue(m, RECORD_BOARDS[b]!, dt);
        if (v > 0 && v >= floors[b]!) {
          this.offer(eco, m, true);
          for (let c = 0; c < floors.length; c++) floors[c] = this.board.floor(RECORD_BOARDS[c]!, 0);
          break;
        }
      }
      if (!oldest || m.ageTicks > oldest.ageTicks || (m.ageTicks === oldest.ageTicks && m.id < oldest.id)) oldest = m;
      if (!parent || m.children > parent.children || (m.children === parent.children && m.id < parent.id)) parent = m;
      const k = boardValue(m, "kills");
      if (!killer || k > kills || (k === kills && m.id < killer.id)) {
        killer = m;
        kills = k;
      }
      if (m.depth > depth) depth = m.depth;
    }
    stats.depth = depth;
    stats.best = oldest && parent && killer ? { age: oldest.id, children: parent.id, kills: killer.id } : null;
    if (records) {
      stats.records = this.board
        .snapshot()
        .map((l) => ({
          board: l.board as RecordBoard,
          entries: l.entries.map((e): WireRecord => ({ id: e.id, hue: Math.round(e.hue), value: Math.round(e.value), from: Math.round(e.from), to: Math.round(e.to), alive: e.alive, plan: e.plan })),
        }));
    }
  }

  // The history message, cached until a new sample.
  history(): string {
    this.historyJson ??= JSON.stringify({ t: "history", samples: this.samples, lineage: this.lineage } satisfies History);
    return this.historyJson;
  }
}
