// B4: runs the Live add panel's training (src/live/training.ts, unchanged) in a real browser page and counts what the Arena worker reports.
// The page sits one folder below the site root like live/index.html, so training.ts finds ../pool.json and ../rl/library.json as on the site.
import { DESIGN_PANEL, designLearner } from "../../../../src/typescript/src/sim/rl/designPanel.ts";
import { EXTRA_DESIGNS } from "../../../../src/typescript/src/sim/rl/b1Bodies.ts";
import { parseFounders } from "../../../../src/typescript/src/live/founders.ts";
import { phasesFor, tierById, train } from "../../../../src/typescript/src/live/training.ts";
import type { LivePhase } from "../../../../src/typescript/src/live/training.ts";

interface PhaseLog { kind: string; seconds: number; readyAt: number; endAt: number; iters: number; checks: number; episodes: number; envs: number; kept: boolean; start: number | null; held: number | null; iterAt: number[] }
interface Spec { tier: string; body: string; fresh: boolean }

// Tee every message of the Arena worker without touching training.ts: its Worker constructor is the only entry.
let tee: ((m: { type: string; it?: { iter: number; held: number | null } }) => void) | null = null;
const Native = window.Worker;
window.Worker = class extends Native {
  constructor(url: string | URL, opts?: WorkerOptions) {
    super(url, opts);
    this.addEventListener("message", (ev) => tee?.((ev as MessageEvent).data));
  }
} as typeof Worker;

const perIter = (p: LivePhase, envs: number): number => (p.method === "es" ? 2 * (p.es?.pairs ?? 24) * envs : p.backprop?.episodes ?? 16); // 1 episode per candidate and env; ES_OPTIONS.pairs is 24
const HELD_SEEDS = 4; // arenaRun's default held-out seeds per env

async function run(spec: Spec): Promise<unknown> {
  const tier = tierById(spec.tier);
  let plan, genome: Float32Array;
  if (spec.body === "grazer") {
    const f = parseFounders(await (await fetch(new URL("../live-founders.json", document.baseURI))).json()).find((x) => x.name === "Grazer")!;
    plan = f.plan;
    genome = f.genome;
  } else {
    const d = [...DESIGN_PANEL, ...EXTRA_DESIGNS].find((x) => x.id === spec.body || x.id.startsWith(spec.body + "-"))!;
    const l = designLearner(d);
    plan = l.plan;
    genome = l.genome;
  }
  const t0 = performance.now();
  const phases: PhaseLog[] = [];
  for (const phase of phasesFor(spec.fresh, tier)) {
    const log: PhaseLog = { kind: phase.kind, seconds: phase.seconds, readyAt: 0, endAt: 0, iters: 0, checks: 0, episodes: 0, envs: phase.envs.length, kept: false, start: null, held: null, iterAt: [] };
    tee = (m) => {
      if (m.type === "ready") log.readyAt = (performance.now() - t0) / 1000;
      else if (m.type === "iteration" && m.it) {
        log.iters = m.it.iter;
        log.iterAt.push(Math.round(performance.now() - t0) / 1000);
        if (m.it.held !== null) { log.checks++; log.held = m.it.held; }
      }
    };
    let err = "";
    const job = train(phase, plan, genome, (p) => { log.start = p.start; }, (m) => (err = m));
    const out = await job.done;
    tee = null;
    log.endAt = (performance.now() - t0) / 1000;
    log.kept = out !== null;
    log.episodes = log.iters * perIter(phase, phase.envs.length) + log.checks * HELD_SEEDS * phase.envs.length;
    if (err) throw new Error(err);
    if (out) genome = out;
    phases.push(log);
  }
  return { spec, wall: (performance.now() - t0) / 1000, phases, cores: navigator.hardwareConcurrency };
}
(window as unknown as { runB4: typeof run }).runB4 = run;
