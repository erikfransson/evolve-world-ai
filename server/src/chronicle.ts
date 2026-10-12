import type { EcoCreature, Ecosystem } from "../../src/typescript/src/sim/ecosystem.ts";
import { Leaderboard, boardValue } from "../../src/typescript/src/sim/leaderboard.ts";
import { HISTORY_FIELDS, LINEAGE_FIELDS, LINEAGE_TOP, MAX_HISTORY, MAX_LINEAGE_HISTORY, MAX_RECORDS, RECORD_BOARDS } from "../../src/typescript/src/live/protocol.ts";
import type { History, RecordBoard, Stats, WireLineage, WireRecord } from "../../src/typescript/src/live/protocol.ts";
import { wireName } from "../../src/typescript/src/live/add.ts";

export const SAMPLE_EVERY_S = 20; // simulated seconds between population samples: MAX_HISTORY of them span 6 simulated hours
export const LINEAGE_EVERY_S = 120; // and between lineage samples, the same 6 hours

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
  observe(eco: Ecosystem, stats: Stats, records: boolean): void {
    if (this.watched !== eco) this.reset(eco);
    const t = eco.tick * eco.config.dt;
    const top = eco.lineages.top(LINEAGE_TOP);
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
    stats.lineages = top.map((l): WireLineage => {
      const { name, starter } = wireName(eco.lineageName(l.founder));
      return { founder: l.founder, hue: Math.round(l.hue), pool: l.pool, count: l.count, ...(name ? { name, ...(starter ? { starter } : {}) } : {}) };
    });
    let oldest: EcoCreature | null = null;
    let parent: EcoCreature | null = null;
    let depth = 0;
    for (const m of eco.members) {
      this.offer(eco, m, true);
      if (!oldest || m.ageTicks > oldest.ageTicks || (m.ageTicks === oldest.ageTicks && m.id < oldest.id)) oldest = m;
      if (!parent || m.children > parent.children || (m.children === parent.children && m.id < parent.id)) parent = m;
      if (m.depth > depth) depth = m.depth;
    }
    stats.depth = depth;
    stats.best = oldest && parent ? { age: oldest.id, children: parent.id } : null;
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
