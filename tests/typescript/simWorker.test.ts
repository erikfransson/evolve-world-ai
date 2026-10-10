import { DEFAULT_CONFIG, withOverrides } from "../../src/typescript/src/sim/config.ts";
import type { GenerationMessage, InMessage, OutMessage } from "../../src/typescript/src/worker/protocol.ts";

const config = withOverrides(DEFAULT_CONFIG, { population: { size: 6 }, creature: { maxLifeSeconds: 3 } });

// The worker script talks to its global scope, so stand one in and drive it by message.
// With the serial evaluator the loop never yields to timers, so the stand-in pauses it after `stopAt` generations.
const sent: OutMessage[] = [];
let stopAt = 0;
const generations = () => sent.filter((m): m is GenerationMessage => m.type === "generation");
const self = {
  postMessage: (msg: OutMessage) => {
    sent.push(msg);
    if (generations().length >= stopAt) send({ type: "pause" });
  },
  onmessage: null as ((e: { data: InMessage }) => void) | null,
};
const send = (data: InMessage) => self.onmessage!({ data });

beforeAll(async () => {
  vi.stubGlobal("self", self);
  await import("../../src/typescript/src/worker/simWorker.ts");
});
afterAll(() => {
  send({ type: "pause" });
  vi.unstubAllGlobals();
});

describe("sim worker", () => {
  it("evolves generation after generation until paused, and resumes", async () => {
    stopAt = 2;
    send({ type: "start", config });
    await vi.waitFor(() => expect(generations().length).toBe(2));
    const [g0, g1] = generations();
    expect([g0!.result.generation, g1!.result.generation]).toEqual([0, 1]);
    expect(g0!.populationSize).toBe(6);
    expect(g0!.genomes.length).toBe(6 * g0!.genomeLength);
    expect(g1!.bestEver).toBeGreaterThanOrEqual(g0!.result.bestFitness);
    await new Promise((r) => setTimeout(r, 50));
    expect(generations().length).toBe(2); // paused

    stopAt = 3;
    send({ type: "resume" });
    await vi.waitFor(() => expect(generations().length).toBe(3));
    expect(generations()[2]!.result.generation).toBe(2);
  });

  it("replays the best genome of a past generation and reports a bad request", async () => {
    const first = generations()[0]!;
    const length = first.genomeLength;
    const i = first.result.bestIndex;
    send({
      type: "past", request: 1, generation: 0, layoutSeed: first.result.layoutSeed, genomeLength: length,
      indices: Uint32Array.of(i), genomes: first.genomes.slice(i * length, (i + 1) * length),
    });
    await vi.waitFor(() => expect(sent.some((m) => m.type === "past")).toBe(true));
    const past = sent.find((m) => m.type === "past")!;
    if (past.type !== "past") throw new Error("unreachable");
    expect(past.request).toBe(1);
    expect(past.bestIndex).toBe(i);
    expect(past.genome).toEqual(first.genomes.slice(i * length, (i + 1) * length));

    send({ type: "past", request: 2, generation: 0, layoutSeed: 1, genomeLength: length, indices: Uint32Array.of(0), genomes: new Float32Array(3) });
    await vi.waitFor(() => expect(sent.some((m) => m.type === "pastError" && m.request === 2)).toBe(true));
  });

  it("restarts from generation 0 on a new start message", async () => {
    sent.length = 0;
    stopAt = 1;
    send({ type: "start", config: withOverrides(config, { seed: 99 }) });
    await vi.waitFor(() => expect(generations().length).toBe(1));
    expect(generations()[0]!.result.generation).toBe(0);
  });
});
