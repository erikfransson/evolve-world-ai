// One founder's family among the living.
export interface Lineage {
  founder: number;
  hue: number; // the founder's own colour, degrees
  pool: boolean; // the founder came from the seed pool
  count: number; // living descendants, the founder included
  species: number; // the founder's species, so all its descendants'
}

// Living creatures per founder and each founder's colour, species and origin, indexed by founder id; updated on birth and death only.
export class Lineages {
  private readonly live: Int32Array;
  private readonly hue: Float32Array;
  private readonly species: Int32Array;
  private readonly pool: Uint8Array;

  readonly founders: number;
  // Living lineages founded at runtime (Ecosystem.insertCreature), keyed by founder id, which lies at or above `founders`; ids only grow, so insertion order is id order.
  private readonly late = new Map<number, { live: number; hue: number; species: number; pool: boolean; name: string }>();

  constructor(founders: number) {
    this.founders = founders;
    this.live = new Int32Array(founders);
    this.hue = new Float32Array(founders);
    this.species = new Int32Array(founders);
    this.pool = new Uint8Array(founders);
  }

  // Records founder f's colour, species and origin.
  describe(f: number, hue: number, species: number, fromPool: boolean, name = ""): void {
    if (f >= this.founders) {
      this.late.set(f, { live: 0, hue: Math.fround(hue), species, pool: fromPool, name });
      return;
    }
    this.hue[f] = hue;
    this.species[f] = species;
    this.pool[f] = fromPool ? 1 : 0;
  }

  // A founder stands alone, a child joins its founder's family, and a death leaves it.
  found(f: number): void {
    if (f >= this.founders) this.late.get(f)!.live = 1;
    else this.live[f] = 1;
  }

  born(f: number): void {
    if (f >= this.founders) this.late.get(f)!.live++;
    else this.live[f]!++;
  }

  // A runtime lineage whose last member dies is dropped, so inserted founders do not pile up in saves.
  died(f: number): void {
    if (f < this.founders) {
      this.live[f]!--;
      return;
    }
    const l = this.late.get(f)!;
    if (--l.live <= 0) this.late.delete(f);
  }

  colour(f: number): number {
    return f >= this.founders ? (this.late.get(f)?.hue ?? 0) : (this.hue[f] ?? 0);
  }

  fromPool(f: number): boolean {
    return f >= this.founders ? (this.late.get(f)?.pool ?? false) : this.pool[f] === 1;
  }

  size(f: number): number {
    return f >= this.founders ? (this.late.get(f)?.live ?? 0) : (this.live[f] ?? 0);
  }

  // The first founder whose row counts a different number of living than the map says (missing means 0), or -1 when all agree.
  firstMismatch(living: ReadonlyMap<number, number>): number {
    for (let f = 0; f < this.founders; f++) if (this.live[f] !== (living.get(f) ?? 0)) return f;
    for (const [f, l] of this.late) if (l.live !== (living.get(f) ?? 0)) return f;
    return -1;
  }

  // True when f has a row in the table.
  has(f: number): boolean {
    return f >= 0 && (f < this.founders || this.late.has(f));
  }

  // Clears the name tag of every runtime lineage whose name passes `match`; returns how many were cleared.
  clearNames(match: (name: string) => boolean): number {
    let n = 0;
    for (const l of this.late.values()) {
      if (l.name && match(l.name)) {
        l.name = "";
        n++;
      }
    }
    return n;
  }

  // The name tag given at insertion, "" for none.
  name(f: number): string {
    return this.late.get(f)?.name ?? "";
  }

  // The whole table as plain data, and back (same founders count).
  toState(): LineageState {
    return {
      founders: this.founders,
      live: Array.from(this.live),
      hue: Array.from(this.hue),
      species: Array.from(this.species),
      pool: Array.from(this.pool),
      late: [...this.late].map(([id, l]) => [id, l.live, l.hue, l.species, l.pool ? 1 : 0, l.name]),
    };
  }

  load(s: LineageState): void {
    if (s.founders !== this.founders) throw new Error("lineage table has a different founder count");
    for (const col of [s.live, s.hue, s.species, s.pool]) if (!Array.isArray(col) || col.length !== this.founders) throw new Error("lineage table columns do not match the founder count");
    if (!Array.isArray(s.late)) throw new Error("lineage table has no late list");
    this.live.set(s.live);
    this.hue.set(s.hue);
    this.species.set(s.species);
    this.pool.set(s.pool);
    this.late.clear();
    for (const [id, live, hue, species, pool, name] of s.late) if (live > 0) this.late.set(id, { live, hue, species, pool: pool === 1, name }); // older saves kept extinct rows
  }

  // The k largest living lineages, of one species or of all (-1), biggest first, ties to the lowest founder id. Scans the founders, not the creatures.
  top(k: number, species = -1): Lineage[] {
    const top: Lineage[] = [];
    const consider = (founder: number, count: number, hue: number, sp: number, pool: boolean): void => {
      if (count === 0 || (species >= 0 && sp !== species) || (top.length === k && count <= top[k - 1]!.count)) return;
      let at = top.length;
      while (at > 0 && top[at - 1]!.count < count) at--;
      top.splice(at, 0, { founder, hue, pool, count, species: sp });
      if (top.length > k) top.pop();
    };
    for (let f = 0; f < this.founders; f++) consider(f, this.live[f]!, this.hue[f]!, this.species[f]!, this.pool[f] === 1);
    for (const [f, l] of this.late) consider(f, l.live, l.hue, l.species, l.pool);
    return top;
  }
}

// Plain-data form of a Lineages table; late rows are [founder id, living, hue, species, pool 0/1, name].
export interface LineageState {
  founders: number;
  live: number[];
  hue: number[];
  species: number[];
  pool: number[];
  late: [number, number, number, number, number, string][];
}
