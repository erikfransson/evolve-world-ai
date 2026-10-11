import type { EngineConfig } from "../sim/config.ts";
import type { Ecosystem } from "../sim/ecosystem.ts";
import { ShareCoordinator, ShareHelper, grownCaps, packetBytes, packetViews } from "../sim/ecoShare.ts";
import type { Caps, Packet } from "../sim/ecoShare.ts";

// Helper threads for one Ecosystem run (see ecoShare.ts), over message passing or shared memory.
// Fork-join: each tick every helper gets its own copy of the packet by transfer and hands it back with its outputs.
// Shared: one SharedArrayBuffer packet, and an epoch counter and a done counter as barriers (Atomics); no messages per tick.

export type HelperIn =
  | { type: "init"; config: EngineConfig; worldCapacity: number; index: number; control?: SharedArrayBuffer } // a new run; control in shared mode
  | { type: "packet"; packet: SharedArrayBuffer } // shared mode: the packet buffer, sent again when it grows
  | { type: "tick"; buffer: ArrayBuffer }; // fork-join: one tick's packet, transferred both ways

export type HelperOut = { type: "ready" } | { type: "done"; buffer: ArrayBuffer } | { type: "error"; message: string };

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
const WAIT_MS = 20_000; // a shared tick waiting longer than this has lost a helper

type WaitAsync = (a: Int32Array, i: number, v: number) => { async: boolean; value: Promise<unknown> | string };
const waitAsync = (Atomics as unknown as { waitAsync?: WaitAsync }).waitAsync;

// Helper threads when none are asked for: leave one core for the page and one for the coordinator, at most 6.
export function defaultHelpers(cores: number): number {
  return Math.max(1, Math.min(cores - 1, 6));
}

// Shared memory needs a cross-origin isolated page (or Node), SharedArrayBuffer and Atomics.waitAsync for the helpers.
export function canShare(scope: { crossOriginIsolated?: boolean } = globalThis, node = false): boolean {
  return (node || scope.crossOriginIsolated === true) && typeof SharedArrayBuffer === "function" && typeof waitAsync === "function";
}

export class ThinkPool {
  readonly shared: boolean;
  watch: number | null = null; // id of a creature the coordinator also senses itself, so its rays and inputs are fresh for the page
  private readonly ports: HelperPort[];
  private coordinator: ShareCoordinator;
  private caps: Caps | null = null;
  private packets: Packet[] = [];
  private readonly control: Int32Array | null;
  private waiting: { count: number; resolve: () => void; reject: (e: unknown) => void } | null = null;
  private broken: unknown = null;

  // shared: use shared memory; check canShare() first.
  constructor(ports: HelperPort[], shared: boolean) {
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

  // Prepares the helpers for a new run; eco must have been built with the journal option and not stepped yet.
  start(eco: Ecosystem): Promise<void> {
    if (this.broken) return Promise.reject(this.broken);
    this.coordinator = new ShareCoordinator(this.ports.length);
    this.caps = null;
    this.packets = [];
    const control = this.control?.buffer as SharedArrayBuffer | undefined;
    const done = this.expect();
    this.ports.forEach((port, index) => port.post({ type: "init", config: eco.config, worldCapacity: eco.world.count, index, control }));
    return done;
  }

  // One tick of eco: helpers sense and think, then the coordinator moves and runs the shared phase.
  // Returns a promise when the tick waits for messages (always in fork-join, when the packet grows in shared mode).
  step(eco: Ecosystem): void | Promise<void> {
    if (this.broken) throw this.broken;
    const caps = grownCaps(this.caps, this.coordinator.need(eco));
    if (caps) return this.resize(caps).then(() => this.tick(eco));
    return this.tick(eco);
  }

  close(): void {
    this.fail(new Error("pool closed"));
  }

  private resize(caps: Caps): Promise<void> {
    this.caps = caps;
    const bytes = packetBytes(caps);
    if (!this.shared) {
      this.packets = this.ports.map(() => packetViews(new ArrayBuffer(bytes), caps));
      return Promise.resolve();
    }
    const packet = new SharedArrayBuffer(bytes);
    const views = packetViews(packet, caps);
    this.packets = this.ports.map(() => views);
    const done = this.expect();
    for (const port of this.ports) port.post({ type: "packet", packet });
    return done;
  }

  private tick(eco: Ecosystem): void | Promise<void> {
    const first = this.packets[0]!;
    this.coordinator.publish(eco, first);
    if (this.shared) {
      const control = this.control!;
      Atomics.store(control, C_DONE, 0);
      Atomics.add(control, C_EPOCH, 1);
      Atomics.notify(control, C_EPOCH);
      this.senseWatched(eco);
      const n = this.ports.length;
      for (let done = Atomics.load(control, C_DONE); done < n; done = Atomics.load(control, C_DONE)) {
        if (Atomics.wait(control, C_DONE, done, WAIT_MS) === "timed-out") this.fail(new Error("helper threads stopped answering"));
        if (this.broken) throw this.broken;
      }
      if (Atomics.load(control, C_FAIL)) {
        this.fail(new Error("a helper thread failed"));
        throw this.broken;
      }
      this.finish(eco);
      return;
    }
    const state = new Uint8Array(first.buffer, 0, first.outputAt);
    for (let h = 1; h < this.packets.length; h++) new Uint8Array(this.packets[h]!.buffer, 0, first.outputAt).set(state);
    const done = this.expect();
    this.ports.forEach((port, h) => {
      const buffer = this.packets[h]!.buffer as ArrayBuffer;
      port.post({ type: "tick", buffer }, [buffer]);
    });
    this.senseWatched(eco);
    return done.then(() => this.finish(eco));
  }

  private finish(eco: Ecosystem): void {
    this.coordinator.collect(eco, this.packets);
    eco.finishTick();
  }

  // Runs the watched creature on this thread as well (same outputs), so its rays and brain inputs are current.
  private senseWatched(eco: Ecosystem): void {
    if (this.watch === null) return;
    const members = eco.members;
    for (let i = 0; i < members.length; i++) {
      if (members[i]!.id !== this.watch) continue;
      eco.prepareTick();
      eco.sensePhase(i, i + 1);
      return;
    }
  }

  // A promise for one reply from every helper.
  private expect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiting = { count: this.ports.length, resolve, reject };
    });
  }

  private receive(h: number, msg: HelperOut): void {
    if (msg.type === "error") return this.fail(new Error(msg.message));
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

  const runShared = (): void => {
    try {
      helper!.run(packet!);
    } catch (error) {
      Atomics.store(control!, C_FAIL, 1);
      post({ type: "error", message: error instanceof Error ? error.message : String(error) });
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
    switch (msg.type) {
      case "init":
        helper = new ShareHelper(msg.config, msg.worldCapacity, msg.index);
        if (msg.control && !control) {
          control = new Int32Array(msg.control);
          void loop(control);
        }
        post({ type: "ready" });
        break;
      case "packet":
        packet = packetViews(msg.packet);
        post({ type: "ready" });
        break;
      case "tick":
        helper!.run(packetViews(msg.buffer));
        post({ type: "done", buffer: msg.buffer }, [msg.buffer]);
        break;
    }
  };
}
