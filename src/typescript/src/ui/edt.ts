// Euclidean distance transform (Felzenszwalb and Huttenlocher), for the shading of rock and the shelves of ground.

const INF = 1e20;
function dt1(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = 0;
    for (;;) {
      const p = v[k]!;
      s = (f[q]! + q * q - (f[p]! + p * p)) / (2 * q - 2 * p);
      if (s <= z[k]!) k--;
      else break;
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    const p = v[k]!;
    d[q] = (q - p) * (q - p) + f[p]!;
  }
}

// Euclidean distance in pixels from each inside pixel to the nearest outside one (0 outside).
export function distance(inside: Uint8Array, w: number, h: number): Float32Array {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const g = new Float64Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = inside[y * w + x] ? INF : 0;
    dt1(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y]!;
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x]!;
    dt1(f, w, d, v, z);
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(d[x]!);
  }
  return out;
}

// The inside of closed outlines (flat x, y lists, even-odd) on a grid of w x h pixels of `cell` world units from (ox, oy): 1 where the pixel centre is inside.
export function fillLoops(loops: readonly number[][], ox: number, oy: number, cell: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const rows: number[][] = Array.from({ length: h }, () => []);
  for (const loop of loops) {
    const n = loop.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x1 = loop[2 * i]!;
      const y1 = (loop[2 * i + 1]! - oy) / cell - 0.5; // in pixel rows, centres at integers
      const x2 = loop[2 * j]!;
      const y2 = (loop[2 * j + 1]! - oy) / cell - 0.5;
      if (y1 === y2) continue;
      const lo = Math.max(0, Math.ceil(Math.min(y1, y2)));
      const hi = Math.min(h - 1, Math.ceil(Math.max(y1, y2)) - 1); // a row centre y counts for an edge when min <= y < max
      for (let r = lo; r <= hi; r++) rows[r]!.push(x1 + ((r - y1) * (x2 - x1)) / (y2 - y1));
    }
  }
  for (let r = 0; r < h; r++) {
    const xs = rows[r]!.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil((xs[k]! - ox) / cell - 0.5));
      const b = Math.min(w - 1, Math.ceil((xs[k + 1]! - ox) / cell - 0.5) - 1);
      for (let x = a; x <= b; x++) out[r * w + x] = 1;
    }
  }
  return out;
}

// Three passes of a box blur of radius r pixels along each axis, edges clamped: close to a gaussian of sigma about 1.1 r.
export function boxBlur(a: Float32Array, w: number, h: number, r: number): void {
  if (r < 1) return;
  const line = new Float32Array(Math.max(w, h) + 2 * r + 1);
  const pass = (n: number, stride: number, count: number, step: number): void => {
    for (let c = 0; c < count; c++) {
      const base = c * step;
      for (let i = 0; i < n; i++) line[i + r] = a[base + i * stride]!;
      for (let i = 0; i < r; i++) {
        line[i] = a[base]!;
        line[n + r + i] = a[base + (n - 1) * stride]!;
      }
      let sum = 0;
      for (let i = 0; i <= 2 * r; i++) sum += line[i]!;
      for (let i = 0; i < n; i++) {
        a[base + i * stride] = sum / (2 * r + 1);
        sum += line[i + 2 * r + 1]! - line[i]!;
      }
    }
  };
  for (let k = 0; k < 3; k++) {
    pass(w, 1, h, w);
    pass(h, w, w, 1);
  }
}
