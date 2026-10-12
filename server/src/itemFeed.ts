import { MAX_DELTAS, deltaMessage } from "../../src/typescript/src/live/protocol.ts";

// The last MAX_DELTAS frames' item changes, so each viewer gets the changes since the last frame it got, whatever its stride.
export class ItemFeed {
  private readonly ring = new Map<number, Uint8Array | null>(); // by frame number; null for a frame too big to send as changes

  push(frameNo: number, chunk: Uint8Array | null): void {
    this.ring.set(frameNo, chunk);
    this.ring.delete(frameNo - MAX_DELTAS);
  }

  clear(): void {
    this.ring.clear();
  }

  // The DELTA message taking a viewer from frame `from` to frame `to`, or null when only the full item set will do:
  // no frame yet (from < 0), too far behind, a frame too big for changes, or changes larger than the full set.
  delta(from: number, to: number, fullBytes: () => number): Uint8Array | null {
    if (from < 0 || to - from > MAX_DELTAS) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (let f = from + 1; f <= to; f++) {
      const c = this.ring.get(f);
      if (!c) return null;
      chunks.push(c);
      size += c.length;
    }
    return size > fullBytes() ? null : deltaMessage(chunks);
  }
}
