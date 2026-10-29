# Brute-force check: f32 gate |s32| <= T32 passes every ray the f64 prefilter (and the exact hit test) passes.
import numpy as np, sys
rng = np.random.default_rng(int(sys.argv[1]) if len(sys.argv) > 1 else 1)
u = 2.0**-24
N = 4_000_000
tot = dict(n=0, pre=0, gate=0, viol_pre=0, viol_hit=0, exact=0); maxratio = 0.0; minslack = 1e9
for rep in range(int(sys.argv[2]) if len(sys.argv) > 2 else 5):
    L = 10**rng.uniform(-1, 3.5, N)                    # ray length 0.1 .. 3000
    r = 10**rng.uniform(-2, 2, N)                      # item radius 0.01 .. 100
    far = L + r + 1e-9*L
    ang = rng.uniform(0, 2*np.pi, N)
    dn = 1 + rng.uniform(-1e-14, 1e-14, N)             # direction length drift
    dx = np.cos(ang)*dn; dy = np.sin(ang)*dn
    # candidate: distance along ray b in [-0.2 far, far], perpendicular s near +-r (tangent) or anywhere
    mode = rng.integers(0, 3, N)
    eps = 10**rng.uniform(-12, -2, N) * rng.choice([-1, 1], N)
    sp = np.where(mode == 0, r*(1+eps), np.where(mode == 1, r*(1+eps)*rng.choice([-1, 1], N), rng.uniform(-1, 1, N)*far))
    b = rng.uniform(-0.2, 1, N)*far
    b = np.minimum(b, np.sqrt(np.maximum(far**2 - sp**2, 0)))
    fx = b*dx - sp*dy; fy = b*dy + sp*dx              # centre = b along ray + sp perpendicular
    # f32 positions: centre relative to creature is a difference of f32 and f64 values, so a plain f64 here
    keep = fx*fx + fy*fy <= far*far
    fx, fy, dx, dy, L, r, far = [a[keep] for a in (fx, fy, dx, dy, L, r, far)]
    # f64 prefilter (kernel: s*s <= r*r + 1e-9*(L+|r|)^2)
    s64 = fx*dy - fy*dx
    rt = r*r + 1e-9*(L + np.abs(r))**2
    pre = s64*s64 <= rt
    # f64 exact test (kernel formula)
    bv = fx*dx + fy*dy; cv = fx*fx + fy*fy - r*r
    disc = bv*bv - cv; inside = cv < 0
    tv = np.where(inside, 0, bv - np.sqrt(np.maximum(disc, 0)))
    hit = pre & (inside | ((bv > 0) & (disc >= 0)))
    # f32 gate
    fx32, fy32, dx32, dy32 = (a.astype(np.float32) for a in (fx, fy, dx, dy))
    s32 = (fx32*dy32 - fy32*dx32).astype(np.float32)
    EF = float(sys.argv[3]) if len(sys.argv) > 3 else 8.0
    E = EF * u * far                                  # default 8u * far
    T = ((np.sqrt(rt) + E) * (1 + 2.0**-23)).astype(np.float32)
    gate = np.abs(s32) <= T
    err = np.abs(s32.astype(np.float64) - s64)
    maxratio = max(maxratio, (err/far).max()/u)
    tot['n'] += keep.sum(); tot['pre'] += pre.sum(); tot['gate'] += gate.sum(); tot['exact'] += hit.sum()
    tot['viol_pre'] += (pre & ~gate).sum(); tot['viol_hit'] += (hit & ~gate).sum()
print(tot, 'max |s32-s64|/far in units of u = %.3f (bound used 8, derived 5.25)' % maxratio)
