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

  constructor(founders: number) {
    this.founders = founders;
    this.live = new Int32Array(founders);
    this.hue = new Float32Array(founders);
    this.species = new Int32Array(founders);
    this.pool = new Uint8Array(founders);
  }

  // Records founder f's colour, species and origin.
  describe(f: number, hue: number, species: number, fromPool: boolean): void {
    this.hue[f] = hue;
    this.species[f] = species;
    this.pool[f] = fromPool ? 1 : 0;
  }

  // A founder stands alone, a child joins its founder's family, and a death leaves it.
  found(f: number): void {
    this.live[f] = 1;
  }

  born(f: number): void {
    this.live[f]!++;
  }

  died(f: number): void {
    this.live[f]!--;
  }

  colour(f: number): number {
    return this.hue[f] ?? 0;
  }

  fromPool(f: number): boolean {
    return this.pool[f] === 1;
  }

  size(f: number): number {
    return this.live[f] ?? 0;
  }

  // The k largest living lineages, of one species or of all (-1), biggest first, ties to the lowest founder id. Scans the founders, not the creatures.
  top(k: number, species = -1): Lineage[] {
    const top: Lineage[] = [];
    for (let f = 0; f < this.founders; f++) {
      const count = this.live[f]!;
      if (count === 0 || (species >= 0 && this.species[f] !== species) || (top.length === k && count <= top[k - 1]!.count)) continue;
      const entry = { founder: f, hue: this.hue[f]!, pool: this.pool[f] === 1, count, species: this.species[f]! };
      let at = top.length;
      while (at > 0 && top[at - 1]!.count < count) at--;
      top.splice(at, 0, entry);
      if (top.length > k) top.pop();
    }
    return top;
  }
}
