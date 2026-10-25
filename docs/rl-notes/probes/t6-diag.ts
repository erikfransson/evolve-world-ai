// T6 probe: why a trained genome stops improving. For each t6-train output: the body plan, output saturation (share of ticks with
// |pre-tanh| > 2 per action, deterministic play), and the ES neighbourhood at several sigmas: candidate share of per-episode variance
// on E common seeds, the cosine of two half-population gradients, and whether the best candidates beat theta on fresh seeds.
// Usage (from src/typescript): node ../../docs/rl-notes/probes/t6-diag.ts [--pairs 20] [--episodes 16] [--sigmas 0.02,0.08,0.3] run.json ...
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parsePool } from "../../../src/typescript/src/sim/seedPool.ts";
import { envById } from "../../../src/typescript/src/sim/rl/envs.ts";
import { HELD_BASE } from "../../../src/typescript/src/sim/rl/trainer.ts";
import { playRollout } from "../../../src/typescript/src/sim/rl/ppo.ts";
import { createRng } from "../../../src/typescript/src/sim/rng.ts";
import { createNodeRlPool } from "../../../src/typescript/src/worker/nodePool.ts";

// parameters
const { values, positionals } = parseArgs({ allowPositionals: true, options: { pairs: { type: "string", default: "20" }, episodes: { type: "string", default: "16" }, sigmas: { type: "string", default: "0.02,0.08,0.3" }, threads: { type: "string", default: "2" } } });
const P = Number(values.pairs), E = Number(values.episodes);
const pool = existsSync("public/pool.json") ? parsePool(JSON.parse(readFileSync("public/pool.json", "utf8"))).entries : null;
const mean = (a: readonly number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const vr = (a: readonly number[]) => mean(a.map((v) => (v - mean(a)) ** 2));

for (const f of positionals) {
  const run = JSON.parse(readFileSync(f, "utf8"));
  const env = envById(run.args.env)!;
  const theta = Float32Array.from(run.genome as number[]);
  const p = run.plan;
  console.log(`${f.split("/").pop()} test ${run.testMean.toFixed(3)}; plan rays ${p.rayCount} spread ${p.raySpread.toFixed(2)} length ${p.rayLength.toFixed(0)} hidden ${p.hiddenLayers.join("x") || "-"} mem ${p.memoryShort}+${p.memoryLong}; ${theta.length} weights`);
  // saturation, on 8 seeds; logStd -9 makes z the mean pre-tanh output
  let sat = [0, 0], n = 0, absz = [0, 0];
  for (let k = 0; k < 8; k++) {
    const r = playRollout(env, p, { env: 0, seed: HELD_BASE + 70000 + k, noiseSeed: 1, theta, critic: new Float32Array(1e5), logStd: new Float64Array(2).fill(-9), repeat: 1, gamma: 0.99, lambda: 0.95, criticHidden: 32 }, pool, {});
    for (let i = 0; i < r.logp.length; i++) for (let a = 0; a < 2; a++) { const z = Math.abs(r.z[2 * i + a]!); absz[a]! += z; if (z > 2) sat[a]!++; }
    n += r.logp.length;
  }
  console.log(`  saturation turn ${(sat[0]! / n).toFixed(2)} thrust ${(sat[1]! / n).toFixed(2)}, mean |u| ${(absz[0]! / n).toFixed(2)} ${(absz[1]! / n).toFixed(2)}`);
  const helpers = createNodeRlPool({ envs: [env], plan: p, pool, library: {} }, Number(values.threads));
  const seeds = Array.from({ length: E }, (_, k) => HELD_BASE + 80000 + k);
  const fresh = Array.from({ length: 64 }, (_, k) => HELD_BASE + 90000 + k);
  const play = async (gs: Float32Array[], ss: number[]) => {
    const r = await helpers.rewards(gs.flatMap((genome) => ss.map((seed) => ({ env: 0, genome, seed }))));
    return gs.map((_, g) => r.slice(g * ss.length, (g + 1) * ss.length));
  };
  const [thetaFresh] = await play([theta], fresh);
  for (const sigma of values.sigmas!.split(",").map(Number)) {
    const rng = createRng(12345);
    const eps: Float32Array[] = [], gs: Float32Array[] = [];
    for (let k = 0; k < P; k++) {
      const e = Float32Array.from(theta, () => rng.normal());
      eps.push(e);
      gs.push(Float32Array.from(theta, (t, i) => t + sigma * e[i]!), Float32Array.from(theta, (t, i) => t - sigma * e[i]!));
    }
    const rew = await play(gs, seeds);
    const cm = rew.map(mean);
    // candidate share: between-candidate variance of the per-seed residual after the seed effect, against the per-episode residual
    const seedMean = seeds.map((_, s) => mean(rew.map((r) => r[s]!)));
    const resid = rew.map((r, g) => r.map((v, s) => v - seedMean[s]! - (cm[g]! - mean(cm))));
    const noise = mean(resid.map((r) => vr(r))) * E / (E - 1);
    const between = Math.max(0, vr(cm) - noise / E);
    const half = (from: number, to: number) => {
      const g = new Float64Array(theta.length);
      for (let k = from; k < to; k++) { const w = cm[2 * k]! - cm[2 * k + 1]!; for (let i = 0; i < g.length; i++) g[i] += w * eps[k]![i]!; }
      return g;
    };
    const a = half(0, P / 2), b = half(P / 2, P);
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) { ab += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2; }
    const top = cm.map((v, i) => [v, i] as const).sort((x, y) => y[0] - x[0]).slice(0, 3).map(([, i]) => gs[i]!);
    const topFresh = (await play(top, fresh)).map(mean);
    console.log(`  sigma ${sigma}: candidates ${mean(cm).toFixed(3)} (theta ${mean(thetaFresh!).toFixed(3)} fresh), share ${(between / (between + noise)).toFixed(3)}, half-grad cos ${(ab / Math.sqrt(aa * bb)).toFixed(3)} (random sd ${(1 / Math.sqrt(theta.length)).toFixed(3)}), top-3 on fresh ${topFresh.map((v) => v.toFixed(2)).join(" ")}`);
  }
  helpers.close();
}
