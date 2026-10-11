// "Gentle on CPU": browsers cannot set OS nice levels, so a gentle worker idles after each slice of work when other programs
// want the CPU, and runs flat out when the machine is otherwise idle. Pacing only changes when work runs, never what it computes.

export type Pressure = "nominal" | "fair" | "serious" | "critical"; // the Compute Pressure API's cpu states

export const MIN_DUTY = 0.3; // gentle never works less than this share of the time
const PRESSURE_DUTY: Record<Pressure, number> = { nominal: 1, fair: 1, serious: 0.6, critical: MIN_DUTY };
const PROBE_DRIFT = 0.001; // per probe, how fast the best time follows a time that stays above it (a slower clock, not contention)
const PROBE_SMOOTHING = 0.3; // weight of the newest probe, which a context switch makes several times longer for a moment
const BACK_OFF_RATIO = 1.5; // smoothed probe time this much above its best means another process is taking our core
const RECOVER_RATIO = 1.2; // below this the competition is gone; between the two the duty is held (hysteresis)
const BACK_OFF_STEP = 0.1;
const RAMP_STEP = 0.05;
const PROBE_GAP_MS = 100; // time between probes
const PROBE_RUNS = 15; // about 3 ms of fixed work: long enough that a competing process gets the core during it, as it does while we compute
const PROBE_ITERATIONS = 5_000; // about 0.2 ms per run

// Idle time that follows a slice of workMs so that work is a share duty of the total: w * (1 - d) / d.
export function idleMs(workMs: number, duty: number): number {
  if (!(workMs > 0) || duty >= 1) return 0;
  const d = Math.max(MIN_DUTY, duty);
  return (workMs * (1 - d)) / d;
}

// Helper threads (Ecosystem) or evaluation workers (Trials) to run: today's count, but the threads together with the
// coordinator stay at cores - 1 so the OS always has a core for the user. Idle machines still get nearly all the speed.
export function gentleCount(normal: number, cores: number): number {
  return Math.max(1, Math.min(normal, cores - 2));
}

// Decides the duty (share of wall time to compute) from the machine's CPU pressure, when the browser reports it,
// and from a fixed calibration probe: it does the same work every time, so if it takes clearly longer than its best,
// other processes are sharing our core. The size of the simulation never enters, only the CPU we get.
export class DutyController {
  private pressureDuty = 1;
  private contentionDuty = 1;
  private smoothed = 0; // recent probe times
  private best = 0; // the lowest smoothed time, creeping up slowly
  private probedAt = -Infinity;

  setPressure(state: Pressure): void {
    this.pressureDuty = PRESSURE_DUTY[state];
  }

  // Runs a probe if the last one was PROBE_GAP_MS ago. Call right after a stretch of work: a thread that has slept gets the core
  // at once, so a probe after sleeping would not notice a competitor; one that was just computing has to share it.
  maybeProbe(nowMs: number): void {
    if (nowMs - this.probedAt < PROBE_GAP_MS) return;
    this.probedAt = nowMs;
    this.probe(runProbe());
  }

  // One probe took wallMs, see runProbe.
  probe(wallMs: number): void {
    if (!(wallMs > 0)) return;
    this.smoothed = this.smoothed === 0 ? wallMs : this.smoothed + PROBE_SMOOTHING * (wallMs - this.smoothed);
    this.best = this.best === 0 || this.smoothed < this.best ? this.smoothed : this.best + PROBE_DRIFT * (this.smoothed - this.best);
    const ratio = this.smoothed / this.best;
    if (ratio > BACK_OFF_RATIO) this.contentionDuty = Math.max(MIN_DUTY, this.contentionDuty - BACK_OFF_STEP);
    else if (ratio < RECOVER_RATIO) this.contentionDuty = Math.min(1, this.contentionDuty + RAMP_STEP);
  }

  duty(): number {
    return Math.min(this.pressureDuty, this.contentionDuty);
  }
}

let sink = 0; // keeps the probe loop from being optimised away

// The calibration probe: a fixed amount of arithmetic, timed on this thread, in ms.
export function runProbe(): number {
  const t0 = performance.now();
  for (let r = 0; r < PROBE_RUNS; r++) {
    let x = 1;
    for (let i = 0; i < PROBE_ITERATIONS; i++) x = (x * 1.0000001 + i) % 1000003;
    sink += x;
  }
  return performance.now() - t0;
}

// Reports the CPU pressure state through the Compute Pressure API where the browser has it (Chrome 125+); does nothing elsewhere.
export function observePressure(onState: (state: Pressure) => void): void {
  try {
    const Observer = (globalThis as { PressureObserver?: new (cb: (records: { state: Pressure }[]) => void) => { observe(source: string, options?: object): Promise<void> } }).PressureObserver;
    if (!Observer) return;
    const observer = new Observer((records) => {
      const last = records[records.length - 1];
      if (last) onState(last.state);
    });
    observer.observe("cpu", { sampleInterval: 1000 }).catch(() => {});
  } catch {
    // unsupported here or blocked by permissions policy: the contention estimate still works
  }
}

// A controller for a gentle worker that also follows the pressure state.
export function gentleController(): DutyController {
  const controller = new DutyController();
  observePressure((state) => controller.setPressure(state));
  runProbe(); // warm-up, so the JIT's first slow run is not the best
  return controller;
}

// Delays the start of the next job of one worker until the idle time after the previous job has passed.
export class Pacer {
  private resumeAt = 0;
  private readonly now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
  }

  // Call when a job that began at startMs has finished, with the duty to idle to.
  finished(startMs: number, duty: number): void {
    const end = this.now();
    this.resumeAt = end + idleMs(end - startMs, duty);
  }

  // Milliseconds to wait before the next job may start.
  wait(): number {
    return Math.max(0, this.resumeAt - this.now());
  }
}
