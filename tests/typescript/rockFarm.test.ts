import { rockFarm } from "../../src/typescript/src/ui/rockFarm.ts";

const job = { id: 1, size: 1, body: { x0: 0, y0: 0, x1: 1, y1: 1, loops: [] } } as unknown as Parameters<ReturnType<typeof rockFarm>["build"]>[0];

function fake() {
  const w = { onmessage: null as ((e: MessageEvent) => void) | null, onerror: null as (() => void) | null, posted: 0, terminated: false, postMessage() { w.posted++; }, terminate() { w.terminated = true; } };
  return w;
}

describe("rockFarm", () => {
  it("retires a worker that errors: terminated, never picked again, and rejects at once when none is left", async () => {
    const made: ReturnType<typeof fake>[] = [];
    const farm = rockFarm(1, () => (made.push(fake()), made[made.length - 1]! as unknown as Worker));
    const first = farm.build(job, 1, false);
    made[0]!.onerror!();
    await expect(first).rejects.toThrow();
    expect(made[0]!.terminated).toBe(true);
    await expect(farm.build(job, 1, false)).rejects.toThrow(); // would wait for ever on the dead slot
    expect(made[0]!.posted).toBe(1);
  });
  it("keeps using the live worker when the other dies, and close() rejects what is pending", async () => {
    const made: ReturnType<typeof fake>[] = [];
    const farm = rockFarm(2, () => (made.push(fake()), made[made.length - 1]! as unknown as Worker));
    const a = farm.build(job, 1, false);
    const b = farm.build(job, 1, false);
    made[0]!.onerror!();
    await expect(a).rejects.toThrow();
    const c = farm.build(job, 1, false);
    expect(made[1]!.posted).toBe(2);
    expect(made[0]!.posted).toBe(1);
    (farm as unknown as { close(): void }).close();
    await expect(b).rejects.toThrow();
    await expect(c).rejects.toThrow();
    expect(made[1]!.terminated).toBe(true);
  });
});
