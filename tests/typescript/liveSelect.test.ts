// @vitest-environment node
// @ts-expect-error the web tsconfig finds no types for the server's ws
import { WebSocket } from "../../server/node_modules/ws/wrapper.mjs";
import { LIMITS } from "../../server/src/config.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { startPublic } from "../../server/src/public.ts";
import type { PublicServer } from "../../server/src/public.ts";
import { MSG_DETAIL, MSG_GENOME } from "../../src/typescript/src/live/protocol.ts";
import { decodeDetail } from "../../src/typescript/src/live/detail.ts";
import { smallConfig } from "./liveHelpers.ts";

type Limits = typeof LIMITS;
const servers: PublicServer[] = [];
async function serve(port: number, change: Partial<Limits> = {}): Promise<{ pub: PublicServer; world: LiveWorld }> {
  const world = new LiveWorld(smallConfig(), null);
  for (let i = 0; i < 30; i++) world.step();
  const pub = startPublic("127.0.0.1", port, world, { ...LIMITS, ...change });
  servers.push(pub);
  await new Promise<void>((r) => (pub.http.listening ? r() : pub.http.once("listening", () => r())));
  return { pub, world };
}
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Client {
  ws: WebSocket;
  details: Buffer[];
  genomes: number;
  detailBytes: number;
  closed: Promise<number>;
  open: Promise<void>;
}
function client(port: number): Client {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
  const c: Client = { ws, details: [], genomes: 0, detailBytes: 0, closed: null!, open: null! };
  c.open = new Promise((r) => ws.on("message", (d: Buffer, bin: boolean) => { if (!bin && JSON.parse(d.toString()).t === "hello") r(); }));
  ws.on("message", (d: Buffer, bin: boolean) => {
    if (!bin) return;
    if (d[0] === MSG_DETAIL) {
      c.details.push(d);
      c.detailBytes += d.length;
    } else if (d[0] === MSG_GENOME) {
      c.genomes++;
      c.detailBytes += d.length;
    }
  });
  c.closed = new Promise((r) => ws.on("close", (code: number) => r(code)));
  ws.on("error", () => {});
  return c;
}
const select = (c: Client, id: unknown): void => c.ws.send(JSON.stringify({ t: "select", id }));

describe("select: validation", () => {
  const cases: [string, (c: Client) => void][] = [
    ["a string id", (c) => select(c, "5")],
    ["a fractional id", (c) => select(c, 1.5)],
    ["a negative id", (c) => select(c, -1)],
    ["a huge id", (c) => select(c, 2 ** 40)],
    ["an extra field", (c) => c.ws.send(JSON.stringify({ t: "select", id: 1, x: 1 }))],
    ["an unknown type", (c) => c.ws.send(JSON.stringify({ t: "insert", id: 1 }))],
    ["not JSON", (c) => c.ws.send("{select")],
    ["a binary message", (c) => c.ws.send(Buffer.from([1, 2, 3]))],
  ];
  cases.forEach(([what, send], k) => {
    it(`cuts off a client that sends ${what}, and the server keeps serving`, async () => {
      const port = 50430 + k;
      const { pub } = await serve(port);
      const bad = client(port);
      await bad.open;
      send(bad);
      expect(await bad.closed).toBe(1006);
      const good = client(port);
      await good.open;
      expect(pub.viewers()).toBe(1);
    });
  });

  it("closes a client whose message is over the size cap", async () => {
    const port = 50440;
    await serve(port);
    const c = client(port);
    await c.open;
    c.ws.send(JSON.stringify({ t: "select", id: 1, pad: "x".repeat(300) }));
    expect(await c.closed).toBe(1009); // ws maxPayload
  });

  it("cuts off a select flood at the message rate", async () => {
    const port = 50441;
    await serve(port);
    const c = client(port);
    await c.open;
    for (let i = 0; i < LIMITS.maxClientMessagesPerSecond + 5; i++) select(c, i);
    expect(await c.closed).toBe(1006);
  });
});

describe("select: details", () => {
  it("sends the followed creature about 5 times a second and its genome once", async () => {
    const port = 50442;
    const { world } = await serve(port);
    const c = client(port);
    await c.open;
    const id = world.eco.members[0]!.id;
    select(c, id);
    await wait(2100);
    expect(c.details.length).toBeGreaterThanOrEqual(8);
    expect(c.details.length).toBeLessThanOrEqual(12);
    expect(c.details.every((d) => decodeDetail(d).id === id)).toBe(true);
    expect(c.genomes).toBe(1);
    select(c, null);
    await wait(300);
    const n = c.details.length;
    await wait(600);
    expect(c.details.length).toBe(n); // letting go stops them
    expect(world.watchedCount).toBe(0);
  });

  it("says once that a creature is gone, then stops", async () => {
    const port = 50443;
    await serve(port);
    const c = client(port);
    await c.open;
    select(c, 4_000_000_000);
    await wait(1200);
    expect(c.details.length).toBe(1);
    expect(decodeDetail(c.details[0]!).details.alive).toBe(false);
  });

  // Each viewer's details come out of its own allowance. Red without it: about 5 x 400 B/s of details plus the genome.
  it("keeps a viewer's detail bytes within its allowance", async () => {
    const port = 50444;
    const rate = 300;
    const burst = 600;
    const { world } = await serve(port, { detailBytesPerViewer: rate, detailBurstBytes: burst });
    const c = client(port);
    await c.open;
    select(c, world.eco.members[0]!.id);
    const t0 = Date.now();
    await wait(3000);
    const seconds = (Date.now() - t0) / 1000;
    expect(c.detailBytes).toBeGreaterThan(0);
    expect(c.detailBytes).toBeLessThanOrEqual(burst + rate * seconds);
  });

  // Selection changes past selectsPerSecond are ignored, so switching cannot pull genome after genome. Red without the limit.
  it("ignores selection changes past the select rate", async () => {
    const port = 50445;
    const { world } = await serve(port);
    const c = client(port);
    await c.open;
    const ids = world.eco.members.map((m) => m.id);
    const t0 = Date.now();
    for (let k = 0; k < 30; k++) {
      select(c, ids[k % ids.length]!);
      await wait(100); // 10 a second, under the message rate
    }
    await wait(400);
    const seconds = (Date.now() - t0) / 1000;
    const followed = new Set(c.details.map((d) => decodeDetail(d).id));
    expect(followed.size).toBeLessThanOrEqual(LIMITS.selectBurst + Math.ceil(LIMITS.selectsPerSecond * seconds));
    expect(c.genomes).toBeLessThanOrEqual(LIMITS.selectBurst + Math.ceil(LIMITS.selectsPerSecond * seconds));
  });

  it("forgets a viewer's selection when it disconnects", async () => {
    const port = 50446;
    const { world, pub } = await serve(port);
    const c = client(port);
    await c.open;
    select(c, world.eco.members[0]!.id);
    await vi.waitFor(() => expect(world.watchedCount).toBe(1));
    c.ws.terminate();
    await vi.waitFor(() => expect(pub.viewers()).toBe(0));
    expect(world.watchedCount).toBe(0);
  });
});
