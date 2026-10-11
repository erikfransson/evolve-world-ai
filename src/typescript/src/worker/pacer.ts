// "Gentle on CPU": browsers cannot set OS nice levels, so a gentle worker idles after each slice of work when other programs
// want the CPU, and runs flat out when the machine is otherwise idle. Pacing only changes when work runs, never what it computes.

export type Pressure = "nominal" | "fair" | "serious" | "critical"; // the Compute Pressure API's cpu states

export const MIN_DUTY = 0.3; // gentle never works less than this share of the time
const PRESSURE_DUTY: Record<Pressure, number> = { nominal: 1, fair: 1, serious: 0.6, critical: MIN_DUTY };
export const FALLBACK_DUTY = 0.9; // without the Compute Pressure API there is no way to see load, so a fixed small share is left idle

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

// The duty (share of wall time to compute): from the machine's CPU pressure when the browser reports it, else fixed.
export class DutyController {
  private current: number;

  constructor(initial = 1) {
    this.current = initial;
  }

  setPressure(state: Pressure): void {
    this.current = PRESSURE_DUTY[state];
  }

  duty(): number {
    return this.current;
  }
}

// Reports the CPU pressure state through the Compute Pressure API where the browser has it (Chrome 125+); does nothing elsewhere.
// Returns whether it is watching.
export function observePressure(onState: (state: Pressure) => void): boolean {
  try {
    const Observer = (globalThis as { PressureObserver?: new (cb: (records: { state: Pressure }[]) => void) => { observe(source: string, options?: object): Promise<void> } }).PressureObserver;
    if (!Observer) return false;
    const observer = new Observer((records) => {
      const last = records[records.length - 1];
      if (last) onState(last.state);
    });
    observer.observe("cpu", { sampleInterval: 1000 }).catch(() => {});
    return true;
  } catch {
    return false; // blocked by permissions policy
  }
}

// A controller for a gentle worker: follows the pressure state, or sits at FALLBACK_DUTY where there is none.
export function gentleController(): DutyController {
  const controller = new DutyController(FALLBACK_DUTY);
  if (observePressure((state) => controller.setPressure(state))) controller.setPressure("nominal");
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
