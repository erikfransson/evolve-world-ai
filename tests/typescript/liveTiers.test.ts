// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AddPanel } from "../../src/typescript/src/live/addPanel.ts";
import { TRAIN_TIERS, cappedEnvs, heldScore, phasesFor, secondsLeft, train } from "../../src/typescript/src/live/training.ts";
import { TRAIN_TIERS_TRAINED } from "../../src/typescript/src/sim/rl/trainTiers.ts";
import { RECOMMENDED_MIX } from "../../src/typescript/src/sim/rl/envs.ts";
import type { LivePhase, TrainProgress } from "../../src/typescript/src/live/training.ts";

class FakeWorker {
  static last: FakeWorker | null = null;
  sent: { type: string; method?: string; envs?: { id: string; seconds: number }[]; options?: Record<string, unknown> }[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(m: FakeWorker["sent"][number]): void {
    this.sent.push(m);
  }
  terminate(): void {
    this.terminated = true;
  }
}
const ready = (extra: object = {}): void => FakeWorker.last!.onmessage!({ data: { type: "ready", held: 0, perEnv: [], ...extra } } as MessageEvent);
const plan = { rayCount: 3, raySpread: 1, rayLength: 100, hiddenLayers: [4], memoryShort: 0, memoryLong: 0 };
const tier = (id: string) => TRAIN_TIERS.find((t) => t.id === id)!;

describe("training tiers as phases", () => {
  it("gives a fresh brain the tier's PPO recipe: method, lr, episodes and the tier's seconds", () => {
    for (const [id, lr, seconds] of [["light", 0.01, 30], ["medium", 0.003, 75], ["strong", 0.001, 200]] as const) {
      const phases = phasesFor(true, tier(id));
      expect(phases).toHaveLength(1);
      expect(phases[0]).toMatchObject({ method: "backprop", backprop: { lr, episodes: 16 }, seconds });
    }
    expect(phasesFor(true, tier("light"))[0]!.cap).toBe(30);
    expect(phasesFor(true, tier("medium"))[0]!.cap).toBeUndefined();
    expect(phasesFor(true, tier("light"))[0]!.envs.filter((e) => e === "live-now")).toHaveLength(2); // the duplicate live-now stays
  });

  it("gives a founder or a file the trained-start tier: PPO lr 0.0005 on the mix, the tier's seconds", () => {
    for (const id of ["light", "medium", "strong"]) {
      const phases = phasesFor(false, tier(id));
      expect(phases.map((p) => [p.kind, p.method, p.seconds, p.backprop])).toEqual([["tier", "backprop", tier(id).seconds, { lr: 0.0005, episodes: 16 }]]);
      expect(phases[0]!.envs).toEqual(TRAIN_TIERS_TRAINED.find((t) => t.id === id)!.phases[0]!.envs);
    }
  });

  it("caps the envs longer than the cap as copies, and leaves the others as they are", () => {
    const all = cappedEnvs(phasesFor(true, tier("light"))[0]!.envs, 30);
    expect(Math.max(...all.map((e) => e.seconds))).toBe(30);
    expect(all.some((e) => e.id.endsWith("-30"))).toBe(true); // live-now (longer than 30 s) became a copy
    expect(cappedEnvs(["nibble"], 30)[0]!.id).toBe("nibble");
    expect(cappedEnvs(["live-now"], undefined)[0]!.seconds).toBeGreaterThan(30);
  });

  it("counts the seconds left over the tier's whole run", () => {
    expect(secondsLeft(75, 0, 75, 0)).toBe(75);
    expect(secondsLeft(60, 30, 30, 0.5)).toBe(15); // second phase of a 2 x 30 s run, half done
    expect(secondsLeft(30, 0, 30, 1.2)).toBe(0);
  });
});

describe("training worker start", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    vi.stubGlobal("Worker", FakeWorker);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("sends PPO with the tier's lr and episodes, the ES defaults, and the capped envs", () => {
    train(phasesFor(true, tier("light"))[0]!, plan, new Float32Array(10), () => {}, () => {});
    const m = FakeWorker.last!.sent[0]!;
    expect(m.method).toBe("backprop");
    expect(m.options).toMatchObject({ backprop: { lr: 0.01, episodes: 16 }, pairs: 24, sigma: 0.05, episodes: 1 });
    expect(Math.max(...m.envs!.map((e) => e.seconds))).toBe(30);
    expect(m.envs!.length).toBe(8);
  });

  it("sends evolution strategies for the ES phases", () => {
    train({ kind: "tier", envs: ["far-food"], seconds: 10, method: "es" }, plan, new Float32Array(10), () => {}, () => {});
    const m = FakeWorker.last!.sent[0]!;
    expect(m.method).toBe("es");
    expect(m.options).toMatchObject({ pairs: 24, lr: 0.02 });
    expect(m.options).not.toHaveProperty("backprop");
  });

  it("starts the clock at ready, so a slow start-up does not eat the seconds", async () => {
    let ended = false;
    const job = train({ kind: "tier", envs: ["nibble"], seconds: 30, method: "es" }, plan, new Float32Array(10), () => {}, () => {});
    void job.done.then(() => (ended = true));
    vi.advanceTimersByTime(50_000); // loading assets: nothing is spent
    await Promise.resolve();
    expect(ended).toBe(false);
    ready();
    vi.advanceTimersByTime(29_000);
    await Promise.resolve();
    expect(ended).toBe(false);
    vi.advanceTimersByTime(1500);
    await Promise.resolve();
    expect(ended).toBe(true);
  });

  it("gives up on a worker that never gets ready, and says so", async () => {
    const errors: string[] = [];
    const job = train({ kind: "tier", envs: ["nibble"], seconds: 30, method: "es" }, plan, new Float32Array(10), () => {}, (m) => errors.push(m));
    vi.advanceTimersByTime(61_000);
    expect(await job.done).toBeNull();
    expect(errors).toHaveLength(1);
  });

  it("reports loading, then the missing seed pool", () => {
    const seen: TrainProgress[] = [];
    train({ kind: "tier", envs: ["nibble"], seconds: 30, method: "es" }, plan, new Float32Array(10), (p) => seen.push(p), () => {});
    vi.advanceTimersByTime(300);
    expect(seen.at(-1)).toMatchObject({ starting: true, share: 0 });
    ready({ poolMissing: true });
    vi.advanceTimersByTime(300);
    expect(seen.at(-1)).toMatchObject({ starting: false, poolMissing: true });
  });
});

describe("re-score worker", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    vi.stubGlobal("Worker", FakeWorker);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  });
  afterEach(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts a 0-iteration ES run on 32 held seeds, the whole uncapped mix and the default poison cost", () => {
    heldScore(plan, new Float32Array(10), 32);
    const m = FakeWorker.last!.sent[0] as unknown as { held: number; method: string; options: Record<string, unknown>; envs: { id: string; seconds: number }[] };
    expect([m.method, m.held, m.options.iterations]).toEqual(["es", 32, 0]);
    expect(m.options).not.toHaveProperty("poisonCost");
    expect(m.envs.map((e) => e.id)).toEqual([...RECOMMENDED_MIX]);
    expect(m.envs.find((e) => e.id === "live-now")!.seconds).toBeGreaterThan(30);
  });

  it("resolves with the ready score and frees the worker", async () => {
    const job = heldScore(plan, new Float32Array(10), 32);
    ready({ held: 4.5 });
    expect(await job.done).toBe(4.5);
    expect(FakeWorker.last!.terminated).toBe(true);
  });

  it("resolves null on a worker error, a timeout, a cancel and a hidden tab, freeing the worker each time", async () => {
    let job = heldScore(plan, new Float32Array(10), 32);
    FakeWorker.last!.onmessage!({ data: { type: "error", message: "x" } } as MessageEvent);
    expect(await job.done).toBeNull();
    expect(FakeWorker.last!.terminated).toBe(true);
    job = heldScore(plan, new Float32Array(10), 32);
    vi.advanceTimersByTime(61_000);
    expect(await job.done).toBeNull();
    expect(FakeWorker.last!.terminated).toBe(true);
    job = heldScore(plan, new Float32Array(10), 32);
    job.cancel();
    expect(await job.done).toBeNull();
    expect(FakeWorker.last!.terminated).toBe(true);
    job = heldScore(plan, new Float32Array(10), 32);
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await job.done).toBeNull();
    expect(FakeWorker.last!.terminated).toBe(true);
  });
});

describe("add panel tiers", () => {
  const setup = async () => {
    const { parseFounders } = await import("../../src/typescript/src/live/founders.ts");
    const { LiveWorld } = await import("../../server/src/liveWorld.ts");
    const { smallConfig } = await import("./liveHelpers.ts");
    const html = readFileSync(join(process.cwd(), "live/index.html"), "utf8");
    document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
    const sent: unknown[] = [];
    const panel = new AddPanel(document.getElementById("addPanel")!, { send: (r) => (sent.push(r), true), added() {}, minimised() {} });
    panel.setRules(new LiveWorld(smallConfig(), null).addRules());
    panel.setFounders(parseFounders(JSON.parse(readFileSync(join(process.cwd(), "public/live-founders.json"), "utf8"))));
    const go = (): Promise<void> => (panel as unknown as { go(): Promise<void> }).go();
    const pick = (id: string): void => { // set the radios by hand (happy-dom does not uncheck the siblings of a click)
      for (const r of document.querySelectorAll<HTMLInputElement>('input[name="addTier"]')) r.checked = r.value === id;
    };
    (document.getElementById("addTrainOn") as HTMLInputElement).checked = true;
    return { panel, sent, go, pick };
  };

  it("offers the three tiers with Light chosen, and training off as before", async () => {
    const { pick } = await setup();
    (document.getElementById("addTrainOn") as HTMLInputElement).checked = false;
    const labels = [...document.querySelectorAll('input[name="addTier"]')].map((i) => (i as HTMLInputElement).value + (i as HTMLInputElement).checked);
    expect(labels).toEqual(["lighttrue", "mediumfalse", "strongfalse"]);
    expect([...document.querySelectorAll("#addTiers span")].map((s) => s.textContent)).toEqual(["Light 30 s", "Medium 75 s", "Strong 200 s"]);
    pick("strong");
  });

  it("trains a fresh brain with the chosen tier's PPO phase and a founder with the trained-start PPO phase", async () => {
    const training = await import("../../src/typescript/src/live/training.ts");
    const calls: LivePhase[] = [];
    const score = vi.spyOn(training, "heldScore").mockImplementation(() => ({ done: Promise.resolve(1), cancel() {} }));
    const spy = vi.spyOn(training, "train").mockImplementation((phase, _p, genome) => {
      calls.push(phase);
      return { done: Promise.resolve(Float32Array.from(genome)), cancel() {}, stoppedHidden: false };
    });
    try {
      const { panel, go, pick } = await setup();
      pick("medium");
      panel.setSource("fresh");
      await go();
      expect(calls.map((c) => [c.method, c.seconds, c.backprop?.lr])).toEqual([["backprop", 75, 0.003]]);
      calls.length = 0;
      panel.reply({ t: "refused", reason: "busy" });
      panel.setSource("founder");
      await go();
      expect(calls.map((c) => [c.kind, c.method, c.seconds, c.backprop?.lr])).toEqual([["tier", "backprop", 75, 0.0005]]);
    } finally {
      spy.mockRestore();
      score.mockRestore();
    }
  });

  it("never reuses a train of another tier, but reuses a finished train of the same one after a refusal", async () => {
    const training = await import("../../src/typescript/src/live/training.ts");
    let runs = 0;
    const spy = vi.spyOn(training, "train").mockImplementation((_ph, _p, genome) => {
      runs++;
      return { done: Promise.resolve(Float32Array.from(genome)), cancel() {}, stoppedHidden: false };
    });
    try {
      const { panel, go, pick } = await setup();
      panel.setSource("fresh");
      await go();
      expect(runs).toBe(1);
      panel.reply({ t: "refused", reason: "busy" });
      await go();
      expect(runs).toBe(1); // same tier: the finished train is reused
      panel.reply({ t: "refused", reason: "busy" });
      pick("strong");
      await go();
      expect(runs).toBe(2); // another tier: trained again
    } finally {
      spy.mockRestore();
    }
  });

  it("does not reuse a partial train as a finished one", async () => {
    const training = await import("../../src/typescript/src/live/training.ts");
    let runs = 0;
    const spy = vi.spyOn(training, "train").mockImplementation((_ph, _p, genome) => {
      runs++;
      return { done: Promise.resolve(Float32Array.from(genome)), cancel() {}, stoppedHidden: true };
    });
    try {
      const { panel, go, sent } = await setup();
      panel.setSource("fresh");
      await go(); // the tab stayed hidden: partial, waits for the visitor
      expect(sent).toHaveLength(0);
      await go(); // the visitor presses Add: the partial result goes in once
      expect(runs).toBe(1);
      expect(sent).toHaveLength(1);
      panel.reply({ t: "refused", reason: "busy" });
      await go(); // refused: the partial result is not a finished train, so it trains again
      expect(runs).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("counts the countdown down from the tier's seconds and notes a missing seed pool", async () => {
    const training = await import("../../src/typescript/src/live/training.ts");
    let finish: (g: Float32Array | null) => void = () => {};
    const spy = vi.spyOn(training, "train").mockImplementation((phase, _p, _g, onProgress) => {
      onProgress({ kind: phase.kind, share: 0.5, starting: false, poolMissing: true, iter: 3, score: null, start: null });
      return { done: new Promise<Float32Array | null>((res) => (finish = res)), cancel() {}, stoppedHidden: false };
    });
    try {
      const { panel, go, pick } = await setup();
      pick("strong");
      panel.setSource("fresh");
      const run = go();
      const text = document.getElementById("addTrainText")!.textContent!;
      expect(text).toContain("100 s left"); // half of 200 s
      expect(text).toContain("seed pool not loaded");
      finish(null);
      await run;
    } finally {
      spy.mockRestore();
    }
  });
});

describe("add panel keeps a trained start only when the re-score says so", () => {
  // scores: what heldScore answers in turn (the start first, then the trained brain); "cancel" leaves the job open until cancelled
  const run = async (scores: (number | null)[], trainReturns: "better" | "same" = "better", hiddenAtEnd = false) => {
    const training = await import("../../src/typescript/src/live/training.ts");
    const { parseFounders } = await import("../../src/typescript/src/live/founders.ts");
    const { LiveWorld } = await import("../../server/src/liveWorld.ts");
    const { smallConfig } = await import("./liveHelpers.ts");
    const html = readFileSync(join(process.cwd(), "live/index.html"), "utf8");
    document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>"));
    const sent: { genome: Float32Array }[] = [];
    const panel = new AddPanel(document.getElementById("addPanel")!, { send: (r) => (sent.push(r as never), true), added() {}, minimised() {} });
    panel.setRules(new LiveWorld(smallConfig(), null).addRules());
    const founders = parseFounders(JSON.parse(readFileSync(join(process.cwd(), "public/live-founders.json"), "utf8")));
    panel.setFounders(founders);
    (document.getElementById("addTrainOn") as HTMLInputElement).checked = true;
    const queue = scores.slice();
    const asked: number[] = [];
    const trainCalls: number[] = [];
    const jobs: { cancel: () => void }[] = [];
    const s1 = vi.spyOn(training, "train").mockImplementation((_ph, _p, genome) => {
      trainCalls.push(1);
      if (hiddenAtEnd) Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      return { done: Promise.resolve(trainReturns === "same" ? null : Float32Array.from(genome, (w) => w + 1)), cancel() {}, stoppedHidden: false };
    });
    const s2 = vi.spyOn(training, "heldScore").mockImplementation((_p, _g, seeds) => {
      asked.push(seeds);
      const next = queue.shift();
      let resolve: (v: number | null) => void = () => {};
      const done = new Promise<number | null>((r) => (resolve = r));
      if (next === undefined) { const job = { done, cancel: () => resolve(null) }; jobs.push(job); return job; }
      return { done: Promise.resolve(next), cancel() {} };
    });
    const go = (): Promise<void> => (panel as unknown as { go(): Promise<void> }).go();
    const msg = (): string => document.getElementById("addMsg")!.textContent!;
    const done = (): void => { s1.mockRestore(); s2.mockRestore(); Object.defineProperty(document, "hidden", { configurable: true, get: () => false }); };
    return { sent, founders, go, msg, asked, trainCalls, jobs, done, panel };
  };

  it("adds the trained brain when it strictly beats the start, scoring both on 32 seeds", async () => {
    const t = await run([1, 2]);
    try {
      await t.go();
      expect(t.asked).toEqual([32, 32]);
      expect(t.sent).toHaveLength(1);
      expect(t.sent[0]!.genome[0]).toBeCloseTo(t.founders[0]!.genome[0]! + 1, 5);
    } finally { t.done(); }
  });

  it("adds the original when the tie or a lower score comes back, and says so", async () => {
    for (const kept of [1, 0.5, NaN]) {
      const t = await run([1, kept]);
      try {
        await t.go();
        expect(t.sent).toHaveLength(1);
        expect(Array.from(t.sent[0]!.genome)).toEqual(Array.from(t.founders[0]!.genome));
        expect(t.msg()).toMatch(/no better brain; adding the original/);
      } finally { t.done(); }
    }
  });

  it("adds the original without a second re-score when training kept nothing", async () => {
    const t = await run([1], "same");
    try {
      await t.go();
      expect(t.asked).toEqual([32]);
      expect(Array.from(t.sent[0]!.genome)).toEqual(Array.from(t.founders[0]!.genome));
      expect(t.msg()).toMatch(/adding the original/);
    } finally { t.done(); }
  });

  it("falls back to the original when the re-score of the trained brain fails", async () => {
    const t = await run([1, null]);
    try {
      await t.go();
      expect(Array.from(t.sent[0]!.genome)).toEqual(Array.from(t.founders[0]!.genome));
      expect(t.msg()).toMatch(/adding the original/);
    } finally { t.done(); }
  });

  it("falls back to the original, without training, when the start cannot be scored", async () => {
    const t = await run([null]);
    try {
      await t.go();
      expect(t.trainCalls).toHaveLength(0);
      expect(Array.from(t.sent[0]!.genome)).toEqual(Array.from(t.founders[0]!.genome));
    } finally { t.done(); }
  });

  it("never adds the unchecked brain when the tab is hidden once training ends", async () => {
    const t = await run([1, 5], "better", true);
    try {
      await t.go();
      expect(t.sent).toHaveLength(0); // waits for the visitor
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      await t.go();
      expect(Array.from(t.sent[0]!.genome)).toEqual(Array.from(t.founders[0]!.genome));
    } finally { t.done(); }
  });

  it("adds nothing when the visitor cancels during the re-score of the trained brain", async () => {
    const t = await run([1]);
    try {
      const go = t.go();
      await vi.waitFor(() => expect(t.jobs).toHaveLength(1)); // the second re-score is open
      expect(document.getElementById("addTrainText")!.textContent).toBe("Checking…");
      expect(document.getElementById("addTrainFill")!.style.width).toBe("100%");
      t.panel.cancelTraining();
      await go;
      expect(t.sent).toHaveLength(0);
      expect(t.msg()).toMatch(/Nothing was added/);
    } finally { t.done(); }
  });

  it("leaves a fresh brain without a re-score", async () => {
    const t = await run([]);
    try {
      t.panel.setSource("fresh");
      await t.go();
      expect(t.asked).toEqual([]);
      expect(t.sent).toHaveLength(1);
    } finally { t.done(); }
  });
});

describe("phasesFor carries a tier phase's own ES options", () => {
  it("passes es through and leaves it out for PPO phases", () => {
    const es = { pairs: 8, sigma: 0.1, lr: 0.05, decay: 0, episodes: 2 };
    const t = { id: "x", label: "X", seconds: 10, phases: [{ envs: ["far-food"], share: 1, method: "es" as const, es }] };
    expect(phasesFor(true, t as never)[0]!.es).toEqual(es);
    expect(phasesFor(true, tier("light"))[0]!.es).toBeUndefined();
  });
});
