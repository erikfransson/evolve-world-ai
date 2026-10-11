import type { ItemsSnapshot } from "./protocol.ts";
import { OP_REMOVE } from "./protocol.ts";

// The page's copy of the world's items, by server slot, kept as dense arrays the renderer draws (itemX, itemY, itemKind, count).
// Each change is O(1): a removed item's place is taken by the last one.
export class ItemMirror {
  x = new Float32Array(0);
  y = new Float32Array(0);
  kind = new Uint8Array(0);
  count = 0;
  private slotAt = new Int32Array(0); // dense index -> slot
  private at = new Int32Array(0); // slot -> dense index, -1 when free
  private slots = 0;

  get capacity(): number {
    return this.slots;
  }

  private grow(n: number): void {
    if (this.x.length >= n) return;
    const size = Math.max(n, 2 * this.x.length, 256);
    const nx = new Float32Array(size);
    const ny = new Float32Array(size);
    const nk = new Uint8Array(size);
    const ns = new Int32Array(size);
    nx.set(this.x.subarray(0, this.count));
    ny.set(this.y.subarray(0, this.count));
    nk.set(this.kind.subarray(0, this.count));
    ns.set(this.slotAt.subarray(0, this.count));
    this.x = nx;
    this.y = ny;
    this.kind = nk;
    this.slotAt = ns;
  }

  reset(s: ItemsSnapshot): void {
    this.slots = s.slots;
    this.at = new Int32Array(s.slots).fill(-1);
    this.count = 0;
    let n = 0;
    for (let i = 0; i < s.slots; i++) if (s.kinds[i]) n++;
    this.grow(n);
    for (let i = 0; i < s.slots; i++) if (s.kinds[i]) this.put(i, s.kinds[i]!, s.x[i]!, s.y[i]!);
  }

  clear(): void {
    this.slots = 0;
    this.at = new Int32Array(0);
    this.count = 0;
  }

  private put(slot: number, kind: number, x: number, y: number): void {
    let i = this.at[slot]!;
    if (i < 0) {
      this.grow(this.count + 1);
      i = this.count++;
      this.at[slot] = i;
      this.slotAt[i] = slot;
    }
    this.x[i] = x;
    this.y[i] = y;
    this.kind[i] = kind;
  }

  private remove(slot: number): void {
    const i = this.at[slot]!;
    if (i < 0) return;
    const last = --this.count;
    if (i !== last) {
      const moved = this.slotAt[last]!;
      this.x[i] = this.x[last]!;
      this.y[i] = this.y[last]!;
      this.kind[i] = this.kind[last]!;
      this.slotAt[i] = moved;
      this.at[moved] = i;
    }
    this.at[slot] = -1;
  }

  // One change; slots outside the known set are ignored (they cannot come from a well-formed server).
  apply(slot: number, kind: number, x: number, y: number): void {
    if (slot < 0 || slot >= this.slots) return;
    if (kind === OP_REMOVE) this.remove(slot);
    else this.put(slot, kind, x, y);
  }

  // Dense index of a slot's item, -1 when free.
  indexOf(slot: number): number {
    return slot >= 0 && slot < this.slots ? this.at[slot]! : -1;
  }

  // The kind at a slot, 0 when free.
  kindAt(slot: number): number {
    const i = slot >= 0 && slot < this.slots ? this.at[slot]! : -1;
    return i < 0 ? 0 : this.kind[i]!;
  }
}
