// "Gentle on CPU": browsers cannot set OS nice levels, so a gentle worker idles after each slice of work when other programs
// want the CPU, and runs flat out when the machine is otherwise idle. Pacing only changes when work runs, never what it computes.

export type Pressure = "nominal" | "fair" | "serious" | "critical"; // the Compute Pressure API's cpu states

export const MIN_DUTY = 0.3; // gentle never works less than this share of the time
const PRESSURE_DUTY: Record<Pressure, number> = { nominal: 1, fair: 1, serious: 0.6, critical: MIN_DUTY };
const SMOOTHING = 0.2; // weight of the newest slice in the running cost
const BASELINE_DRIFT = 0.001; // per slice, how fast the baseline follows a cost that stays above it (a changed workload, not contention)
const BACK_OFF_RATIO = 1.4; // slices this much slower than the baseline mean another process is competing
const RECOVER_RATIO = 1.15; // below this the competition is gone; between the two the duty is held (hysteresis)
const BACK_OFF_STEP = 0.1;
const RAMP_STEP = 0.05;

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
// and from our own slices: a unit of work taking clearly longer than its usual best means others share our core.
export class DutyController {
  private pressureDuty = 1;
  private contentionDuty = 1;
  private cost = 0; // smoothed ms per unit of work
  private baseline = 0; // the lowest smoothed cost, creeping up slowly

  setPressure(state: Pressure): void {
    this.pressureDuty = PRESSURE_DUTY[state];
  }

  // A slice of workMs that did `units` of work (ticks times creatures, creatures evaluated, ...).
  observe(workMs: number, units: number): void {
    if (!(workMs > 0) || !(units > 0)) return;
    const c = workMs / units;
    this.cost = this.cost === 0 ? c : this.cost + SMOOTHING * (c - this.cost);
    this.baseline = this.baseline === 0 || this.cost < this.baseline ? this.cost : this.baseline + BASELINE_DRIFT * (this.cost - this.baseline);
    const ratio = this.cost / this.baseline;
    if (ratio > BACK_OFF_RATIO) this.contentionDuty = Math.max(MIN_DUTY, this.contentionDuty - BACK_OFF_STEP);
    else if (ratio < RECOVER_RATIO) this.contentionDuty = Math.min(1, this.contentionDuty + RAMP_STEP);
  }

  duty(): number {
    return Math.min(this.pressureDuty, this.contentionDuty);
  }
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
