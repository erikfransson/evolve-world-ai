// Index of the creature nearest to the world point (wx, wy) within reach, or -1.
export function pickCreature(xs: Float32Array, ys: Float32Array, count: number, wx: number, wy: number, reach: number): number {
  let best = -1;
  let bestD2 = reach * reach;
  for (let i = 0; i < count; i++) {
    const dx = xs[i]! - wx;
    const dy = ys[i]! - wy;
    const d2 = dx * dx + dy * dy;
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = i;
    }
  }
  return best;
}
