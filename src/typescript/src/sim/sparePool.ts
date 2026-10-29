export const MAX_SPARE = 256; // dead creatures' storage kept per species for reuse by births; a crash would otherwise keep the old peak's brains for good
const SPARE_LOOK = 16; // dead creatures looked at for one whose brain has the newborn's size

// Per species, the dead creatures kept for births to reuse: at most MAX_SPARE each, found by genome length.
export class SparePool<T> {
  private readonly lists: T[][];
  private readonly lengthOf: (item: T) => number;

  constructor(species: number, lengthOf: (item: T) => number) {
    this.lists = Array.from({ length: species }, () => []);
    this.lengthOf = lengthOf;
  }

  count(species: number): number {
    return this.lists[species]!.length;
  }

  // False when the pool of this species is full: the caller releases the item.
  keep(species: number, item: T): boolean {
    const list = this.lists[species]!;
    if (list.length >= MAX_SPARE) return false;
    list.push(item);
    return true;
  }

  // The most recent kept item among the last SPARE_LOOK whose brain has genomeLength genes (so its bank block and buffers fit as they are), else the latest one.
  take(species: number, genomeLength: number): T | undefined {
    const list = this.lists[species]!;
    const top = list.length - 1;
    for (let i = top; i >= 0 && i > top - SPARE_LOOK; i--) {
      if (this.lengthOf(list[i]!) !== genomeLength) continue;
      const item = list[i]!;
      list[i] = list[top]!;
      list.pop();
      return item;
    }
    return list.pop();
  }
}
