import type { EngineConfig } from "../sim/config.ts";
import type { Ecosystem } from "../sim/ecosystem.ts";
import { ShareCoordinator, ShareHelper, fittedCaps, packetBytes, packetViews, publishedBytes } from "../sim/ecoShare.ts";
import type { Caps, Packet } from "../sim/ecoShare.ts";

// Helper threads for one Ecosystem run (see ecoShare.ts), over message passing or shared memory.
// Fork-join: each tick every helper gets a copy of the coordinator's packet by transfer and hands it back with its outputs.
// Shared: one SharedArrayBuffer packet, and an epoch counter and a done counter as barriers (Atomics); no messages per tick.
// gen: the run a message belongs to, echoed in the reply, so a late reply from an earlier run is dropped.

export type HelperIn =
  | { type: "init"; gen: number; config: EngineConfig; worldCapacity: number; index: number; wasm: boolean; control?: SharedArrayBuffer } // a new run; control in shared mode, wasm as the coordinator
  | { type: "packet"; gen: number; packet: SharedArrayBuffer } // shared mode: the packet buffer, sent again when it grows
  | { type: "tick"; gen: number; buffer: ArrayBuffer }; // fork-join: one tick's packet, transferred both ways

export type HelperOut = { type: "ready"; gen: number } | { type: "done"; gen: number; buffer: ArrayBuffer } | { type: "error"; gen: number; message: string };

// What the pool needs from a helper thread, for web workers and node worker_threads.
export interface HelperPort {
  post(msg: HelperIn, transfer?: Transferable[]): void;
  onMessage(callback: (msg: HelperOut) => void): void;
  onError(callback: (error: unknown) => void): void; // any error or unexpected exit
  terminate(): void;
}

// Control slots (Int32) in shared mode.
const C_EPOCH = 0; // bumped by the coordinator when a packet is ready
const C_DONE = 1; // helpers finished with the current packet
const C_FAIL = 2; // set by a helper that threw
const START_MS = 20_000; // helpers not ready for a run after this long are lost (the first start loads their scripts)
const TICK_MS = 5_000; // default for a tick or packet waiting so long that a helper is lost

type WaitAsync = (a: Int32Array, i: number, v: number, timeout?: number) => { async: boolean; value: Promise<unknown> | string };
const waitAsync = (Atomics as unknown as { waitAsync?: WaitAsync }).waitAsync;

// Helper threads when none are asked for: leave one core for the page and one for the coordinator, at most 4; on a 4-core machine 6 were no faster than 4.
export function defaultHelpers(cores: number): number {
  return Math.max(1, Math.min(cores - 1, 4));
}

// Shared memory needs a cross-origin isolated page (or Node), SharedArrayBuffer and Atomics.waitAsync (helpers and coordinator wait without blocking).
export function canShare(scope: { crossOriginIsolated?: boolean } = globalThis, node = false): boolean {
  return (node || scope.crossOriginIsolated === true) && typeof SharedArrayBuffer === "function" && typeof waitAsync === "function";
}

export class ThinkPool {
  readonly shared: boolean;
  watch: number | null = null; // id of a creature the coordinator senses even when a helper owns it, so its rays and inputs are fresh for the page
  private readonly ports: HelperPort[];
  private coordinator: ShareCoordinator;
  private caps: Caps | null = null;
  private home: Packet | null = null; // the coordinator's packet: published here, read by senseOwn and collect
  private packets: Packet[] = []; // helper h's packet; all home when shared
  private readonly control: Int32Array | null;
  private readonly tickMs: number;
  private waiting: { count: number; resolve: () => void; reject: (e: unknown) => void } | null = null;
  private broken: unknown = null;
  private gen = 0; // the current run, see HelperIn
  private last: Promise<unknown> = Promise.resolve(); // the latest start or step; a new start waits for it

  // shared: use shared memory; check canShare() first. tickMs: how long a tick waits for the helpers before the pool fails.
  constructor(ports: HelperPort[], shared: boolean, tickMs = TICK_MS) {
    this.tickMs = tickMs;
    this.ports = ports;
    this.shared = shared;
    this.coordinator = new ShareCoordinator(ports.length);
    this.control = shared ? new Int32Array(new SharedArrayBuffer(16)) : null;
    ports.forEach((port, h) => {
      port.onMessage((msg) => this.receive(h, msg));
      port.onError((error) => this.fail(error));
    });
  }

  get helpers(): number {
    return this.ports.length;
  }

  // False once a helper failed or close() was called; the pool is then useless.
  get alive(): boolean {
    return this.broken === null;
  }

  // Prepares the helpers for a new run, after the previous start or step has finished; eco must have been built with
  // the journal option and not stepped yet.
  start(eco: Ecosystem): Promise<void> {
    const started = this.last.catch(() => {}).then(() => this.begin(eco));
    this.last = started;
    return started;
  }

  // One tick of eco, once start has resolved: helpers sense and think, then the coordinator moves and runs the shared phase.
  step(eco: Ecosystem): Promise<void> {
    const stepped = this.stepNow(eco);
    this.last = stepped;
    return stepped;
  }

  close(): void {
    this.fail(new Error("pool closed"));
  }

  private begin(eco: Ecosystem): Promise<void> {
    if (this.broken) return Promise.reject(this.broken);
    const gen = ++this.gen;
    this.coordinator = new ShareCoordinator(this.ports.length);
    this.caps = null;
    this.home = null;
    this.packets = [];
    const control = this.control?.buffer as SharedArrayBuffer | undefined;
    const done = this.expect(START_MS);
    this.ports.forEach((port, index) => port.post({ type: "init", gen, config: eco.config, worldCapacity: eco.world.count, index, wasm: eco.wasm, control }));
    return done;
  }

  private async stepNow(eco: Ecosystem): Promise<void> {
    if (this.broken) throw this.broken;
    const caps = fittedCaps(this.caps, this.coordinator.need(eco));
    if (caps) await this.resize(caps);
    await this.tick(eco);
  }

  private resize(caps: Caps): Promise<void> {
    this.caps = caps;
    const bytes = packetBytes(caps);
    if (!this.shared) {
      this.home = packetViews(new ArrayBuffer(bytes), caps);
      this.packets = this.ports.map(() => packetViews(new ArrayBuffer(bytes), caps));
      return Promise.resolve();
    }
    const packet = new SharedArrayBuffer(bytes);
    const views = packetViews(packet, caps);
    this.home = views;
    this.packets = this.ports.map(() => views);
    const done = this.expect(this.tickMs);
    for (const port of this.ports) port.post({ type: "packet", gen: this.gen, packet });
    return done;
  }

  private async tick(eco: Ecosystem): Promise<void> {
    const home = this.home!;
    this.coordinator.publish(eco, home);
    if (this.shared) {
      const control = this.control!;
      Atomics.store(control, C_DONE, 0);
      Atomics.add(control, C_EPOCH, 1);
      Atomics.notify(control, C_EPOCH);
      this.senseOwn(eco);
      const n = this.ports.length;
      // Waits without blocking, so a helper's error or exit event fails the pool (and wakes this wait) right away.
      for (let done = Atomics.load(control, C_DONE); done < n; done = Atomics.load(control, C_DONE)) {
        const r = waitAsync!(control, C_DONE, done, this.tickMs);
        if (r.async && (await r.value) === "timed-out") this.fail(new Error("helper threads stopped answering"));
        if (this.broken) throw this.broken;
      }
      if (Atomics.load(control, C_FAIL)) {
        this.fail(new Error("a helper thread failed"));
        throw this.broken;
      }
      this.finish(eco);
      return;
    }
    const state = new Uint8Array(home.buffer, 0, publishedBytes(home));
    for (const p of this.packets) new Uint8Array(p.buffer).set(state);
    const done = this.expect(this.tickMs);
    const gen = this.gen;
    this.ports.forEach((port, h) => {
      const buffer = this.packets[h]!.buffer as ArrayBuffer;
      port.post({ type: "tick", gen, buffer }, [buffer]);
    });
    this.senseOwn(eco);
    await done;
    this.finish(eco);
  }

  private finish(eco: Ecosystem): void {
    this.coordinator.collect(eco, this.home!, this.packets);
    eco.finishTick();
  }

  // The coordinator's own share, while the helpers run theirs.
  private senseOwn(eco: Ecosystem): void {
    eco.prepareTick();
    this.coordinator.senseOwn(eco, this.home!, this.watch);
  }

  // A promise for one reply of the current run from every helper; fails the pool after ms.
  private expect(ms: number): Promise<void> {
    if (this.waiting) throw new Error("helper threads are still busy");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("helper threads stopped answering")), ms);
      this.waiting = {
        count: this.ports.length,
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
    });
  }

  private receive(h: number, msg: HelperOut): void {
    if (msg.type === "error") return this.fail(new Error(msg.message));
    if (msg.gen !== this.gen) return;
    if (msg.type === "done") this.packets[h] = packetViews(msg.buffer);
    const w = this.waiting;
    if (w && --w.count === 0) {
      this.waiting = null;
      w.resolve();
    }
  }

  private fail(error: unknown): void {
    if (this.broken) return;
    this.broken = error;
    for (const port of this.ports) port.terminate();
    if (this.control) Atomics.notify(this.control, C_DONE); // wakes a shared tick waiting for the helpers
    const w = this.waiting;
    this.waiting = null;
    w?.reject(error);
  }
}

// Body of a helper thread: returns the message handler. post sends a reply to the coordinator.
export function serveHelper(post: (msg: HelperOut, transfer?: Transferable[]) => void): (msg: HelperIn) => void {
  let helper: ShareHelper | null = null;
  let control: Int32Array | null = null;
  let packet: Packet | null = null;
  let gen = 0;

  const runShared = (): void => {
    try {
      helper!.run(packet!);
    } catch (error) {
      Atomics.store(control!, C_FAIL, 1);
      post({ type: "error", gen, message: error instanceof Error ? error.message : String(error) });
    }
    Atomics.add(control!, C_DONE, 1);
    Atomics.notify(control!, C_DONE);
  };

  // Waits for each epoch without blocking, so messages (a new run, a grown packet) still arrive between ticks.
  const loop = async (c: Int32Array): Promise<void> => {
    let seen = Atomics.load(c, C_EPOCH);
    for (;;) {
      const r = waitAsync!(c, C_EPOCH, seen);
      if (r.async) await r.value;
      seen = Atomics.load(c, C_EPOCH);
      runShared();
    }
  };

  return (msg) => {
    gen = msg.gen;
    switch (msg.type) {
      case "init":
        helper = new ShareHelper(msg.config, msg.worldCapacity, msg.index, msg.wasm);
        if (msg.control && !control) {
          control = new Int32Array(msg.control);
          void loop(control);
        }
        post({ type: "ready", gen });
        break;
      case "packet":
        packet = packetViews(msg.packet);
        post({ type: "ready", gen });
        break;
      case "tick":
        helper!.run(packetViews(msg.buffer));
        post({ type: "done", gen, buffer: msg.buffer }, [msg.buffer]);
        break;
    }
  };
}
