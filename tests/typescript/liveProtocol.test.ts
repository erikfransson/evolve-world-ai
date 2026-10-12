import { CREATURE_RECORD, ITEMS_HEADER, creatureFrameBytes, decodeCreatures, decodeItems, encodeCreatures, encodeItems } from "../../src/typescript/src/live/protocol.ts";
import { LiveScene } from "../../src/typescript/src/live/scene.ts";
import { retryDelayS, serverUrl, DEV_SERVER, PUBLIC_SERVER } from "../../src/typescript/src/live/serverUrl.ts";
import { LiveLink, cleanStats } from "../../src/typescript/src/live/connection.ts";
import type { Stats } from "../../src/typescript/src/live/protocol.ts";
import { gets, sendStride } from "../../server/src/budget.ts";
import { LiveWorld } from "../../server/src/liveWorld.ts";
import { smallConfig } from "./liveHelpers.ts";
import { applyTunables } from "../../server/src/tunables.ts";
import { ITEM_HEADROOM, LIVE } from "../../server/src/config.ts";

const world = { width: 17000, height: 10600 };

describe("live protocol", () => {
  it("round-trips creature frames within the quantisation", () => {
    const src = {
      count: 3,
      ids: [5, 70000, 9],
      x: [0, 8500.5, 17000],
      y: [10600, 1, 5300],
      heading: [0, Math.PI, -0.5],
      energy: [0, 75, 400],
      hue: [0, 180.25, 359],
      founder: [0, 12, 99999],
      age: [0, 12.7, 1000],
      radius: 12,
    };
    const bytes = encodeCreatures(123, src, world, 150);
    expect(bytes.length).toBe(creatureFrameBytes(3));
    expect(CREATURE_RECORD).toBe(17);
    const f = decodeCreatures(bytes, world);
    expect(f.tick).toBe(123);
    expect(Array.from(f.ids)).toEqual([5, 70000, 9]);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(f.x[i]! - src.x[i]!)).toBeLessThan(world.width / 65535);
      expect(Math.abs(f.y[i]! - src.y[i]!)).toBeLessThan(world.height / 65535);
      expect(f.radius[i]).toBe(12);
    }
    expect(f.heading[2]).toBeCloseTo(2 * Math.PI - 0.5, 3);
    expect(f.energyShare[0]).toBe(0);
    expect(f.energyShare[1]).toBeCloseTo(0.5, 2);
    expect(f.energyShare[2]).toBe(1); // over full is capped
    expect(f.age[2]).toBe(255);
    expect(f.hue[1]).toBeCloseTo(180.25, 1);
    expect(f.founder[2]).toBe(65535);
  });

  it("round-trips an empty frame and rejects a truncated one", () => {
    const empty = encodeCreatures(1, { count: 0, ids: [], x: [], y: [], heading: [], energy: [], hue: [], founder: [], age: [], radius: 12 }, world, 150);
    expect(decodeCreatures(empty, world).count).toBe(0);
    const bytes = encodeCreatures(1, { count: 1, ids: [1], x: [1], y: [1], heading: [0], energy: [1], hue: [1], founder: [1], age: [1], radius: 12 }, world, 150);
    expect(() => decodeCreatures(bytes.slice(0, bytes.length - 1), world)).toThrow();
  });

  it("round-trips the item set by slot and skips free slots", () => {
    const xs = [10, 20, 30, 40, 50];
    const ys = [1, 2, 3, 4, 5];
    const kinds = [1, 0, 2, 1, 0];
    const bytes = encodeItems(7, { xs, ys, kinds, slots: 5 }, world);
    expect(bytes.length).toBe(ITEMS_HEADER + 2 + 4 * 3);
    const f = decodeItems(bytes, world);
    expect(f.tick).toBe(7);
    expect(Array.from(f.kinds)).toEqual([1, 0, 2, 1, 0]);
    expect(f.x[3]).toBeCloseTo(40, 0);
    expect(f.y[2]).toBeCloseTo(3, 0);
    expect(() => decodeItems(bytes, world, 4)).toThrow(); // more slots than the hello said
    expect(() => decodeItems(bytes.slice(0, -1), world)).toThrow();
  });
});

describe("live scene", () => {
  const frame = (tick: number, ids: number[], xs: number[]) => ({
    tick, count: ids.length, ids: Uint32Array.from(ids), x: Float32Array.from(xs), y: new Float32Array(ids.length), heading: new Float32Array(ids.length),
    radius: new Float32Array(ids.length).fill(12), energyShare: new Float32Array(ids.length).fill(0.5), age: new Float32Array(ids.length), hue: new Float32Array(ids.length), founder: new Int32Array(ids.length),
  });

  it("moves matched creatures between frames and drops new ones in place", () => {
    const s = new LiveScene();
    s.fullEnergy = 100;
    s.push(frame(1, [1, 2], [0, 100]), 0);
    s.sample(1000);
    expect(s.views.x[0]).toBe(0);
    s.push(frame(2, [2, 1, 3], [200, 100, 50]), 2000); // order changes, id 3 is new
    s.sample(2100); // the gap of 2000 ms is clamped to a 1200 ms span
    const v = s.views;
    const a = (2100 - 2000) / 1200;
    expect(v.x[s.slotOf(1)]).toBeCloseTo(100 * a, 3);
    expect(v.x[s.slotOf(2)]).toBeCloseTo(100 + 100 * a, 3);
    expect(s.slotOf(3)).toBe(-1); // born at the frame's tick (age 0), so not shown before the timeline gets there
    expect(v.energy[0]).toBe(50);
    s.sample(5000);
    expect(v.x[s.slotOf(1)]).toBeCloseTo(100, 3);
    expect(v.x[s.slotOf(3)]).toBeCloseTo(50, 3);
  });

  it("starts moving from where a creature is at push time, after a long gap", () => {
    const s = new LiveScene();
    s.push(frame(1, [1], [0]), 0);
    s.push(frame(2, [1], [100]), 100); // span 100 ms
    s.push(frame(3, [1], [100]), 100_000); // a hidden tab: nothing was sampled for 100 s
    s.sample(100_000);
    expect(s.views.x[0]).toBeCloseTo(100, 3);
  });

  it("forgets everything on reset, so reused ids of a new world are not matched", () => {
    const s = new LiveScene();
    s.push(frame(1, [1], [0]), 0);
    s.reset();
    expect(s.slotOf(1)).toBe(-1);
    s.push(frame(1, [1], [900]), 10);
    s.sample(10);
    expect(s.views.x[0]).toBeCloseTo(900, 3);
  });
});

describe("speed setting", () => {
  it("accepts 0.25 to 4 and rejects the rest", () => {
    const eco = new LiveWorld(smallConfig(), null).eco;
    expect(applyTunables(eco, { speed: 4 })).toBeNull();
    expect(LIVE.speed).toBe(4);
    expect(applyTunables(eco, { speed: 5 })).not.toBeNull();
    expect(applyTunables(eco, { speed: 0.1 })).not.toBeNull();
    expect(LIVE.speed).toBe(4);
    applyTunables(eco, { speed: 2 });
  });
});

describe("live server helpers", () => {
  it("picks the server url", () => {
    expect(serverUrl("", true)).toBe(DEV_SERVER);
    expect(serverUrl("", false)).toBe(PUBLIC_SERVER);
    expect(serverUrl("?server=wss://a.example/x", true)).toBe("wss://a.example/x");
    expect(serverUrl("?server=wss://a.example/x", false)).toBe(PUBLIC_SERVER);
    expect(serverUrl("?server=javascript:alert(1)", false)).toBe(PUBLIC_SERVER);
    expect(serverUrl("?server=not a url", true)).toBe(DEV_SERVER);
  });

  it("shares the upload budget round-robin", () => {
    expect(sendStride(10, 100_000, 0, 3_000_000)).toBe(1);
    expect(sendStride(100, 100_000, 0, 3_000_000)).toBe(4);
    expect(sendStride(300, 100_000, 0, 3_000_000)).toBe(10); // past MAX_STRIDE: the budget holds, new viewers are refused (public.ts)
    expect(sendStride(100, 100_000, 10_000, 3_000_000)).toBe(5); // item changes reach every viewer whatever its stride, leaving 2 MB/s for frames
    const stride = 3;
    for (let f = 0; f < 6; f++) expect([0, 1, 2].filter((v) => gets(v, f, stride)).length).toBe(1); // one viewer in three per frame
    for (let v = 0; v < 3; v++) expect([0, 1, 2].filter((f) => gets(v, f, stride)).length).toBe(1); // each viewer one frame in three
  });

  it("cleans stats fields", () => {
    const s = cleanStats({ t: "stats", tick: 5, population: "x" as unknown as number, births: NaN, deaths: Infinity, viewers: 3 } as Stats);
    expect(s).toMatchObject({ tick: 5, population: 0, births: 0, deaths: 0, viewers: 3, uptimeS: 0 });
  });

  it("backs off up to 30 s", () => {
    expect(retryDelayS(0, () => 0)).toBe(1);
    expect(retryDelayS(3, () => 0)).toBe(8);
    expect(retryDelayS(20, () => 1)).toBe(37.5);
  });

  it("applies live settings through retune, all or nothing", () => {
    const eco = new LiveWorld(smallConfig(), null).eco;
    expect(applyTunables(eco, { "eco.damagePerSpeed": 0.5, "eco.collisionDamage": false, "eco.birthEnergyRange": [50, 60] })).toBeNull();
    expect(eco.config.eco.damagePerSpeed).toBe(0.5);
    expect(eco.config.eco.collisionDamage).toBe(false);
    expect(applyTunables(eco, { "eco.damagePerSpeed": 0.1, "eco.hueDrift": 99 })).toMatch(/hueDrift/);
    expect(eco.config.eco.damagePerSpeed).toBe(0.5);
    expect(applyTunables(eco, { "eco.damagePerSpeed": 0.1, speed: 99 })).toMatch(/speed/);
    expect(eco.config.eco.damagePerSpeed).toBe(0.5);
    expect(applyTunables(eco, { "world.foodDensity": 1 })).toMatch(/not a live setting/);
    expect(applyTunables(eco, { "eco.seasons": 1 })).toMatch(/seasons/);
    expect(applyTunables(eco, JSON.parse('{"__proto__":1}'))).toMatch(/not a live setting/);
    expect(applyTunables(eco, [])).toMatch(/object/);
  });

  it("lets admin raise the item caps up to the headroom and no further", () => {
    const eco = new LiveWorld(smallConfig(), null).eco;
    expect(applyTunables(eco, { "eco.foodMaxDensity": ITEM_HEADROOM.foodMaxDensity, "eco.poisonMaxDensity": ITEM_HEADROOM.poisonMaxDensity })).toBeNull();
    expect(applyTunables(eco, { "eco.foodMaxDensity": ITEM_HEADROOM.foodMaxDensity + 1 })).toMatch(/item slots/);
    expect(eco.config.eco.foodMaxDensity).toBe(ITEM_HEADROOM.foodMaxDensity);
  });
});

describe("live link", () => {
  // A stand-in WebSocket the test drives by hand.
  class FakeSocket {
    static OPEN = 1;
    static last: FakeSocket | null = null;
    readyState = 0;
    binaryType = "";
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      FakeSocket.last = this;
    }
    close(): void {
      this.onclose?.();
    }
    send(): void {}
  }

  it("reports full only for the try that was told busy", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
    try {
      const states: string[] = [];
      const link = new LiveLink("ws://x", { onState: (s) => states.push(s), onHello() {}, onCreatures() {}, onItems() {}, onDelta() {}, onDetail() {}, onGenome() {}, onStats() {}, onHistory() {} });
      link.start();
      FakeSocket.last!.onmessage!({ data: JSON.stringify({ t: "busy", maxViewers: 1 }) });
      FakeSocket.last!.close();
      expect(states.at(-1)).toBe("full");
      vi.advanceTimersByTime(60_000); // the retry opens a new socket
      FakeSocket.last!.close(); // refused without a busy (e.g. 503 before the upgrade) or the server is down
      expect(states.at(-1)).not.toBe("full");
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
