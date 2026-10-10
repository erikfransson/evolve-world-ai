// Turns frame times into whole simulation ticks, carrying the fraction to the next frame.
export class TickClock {
  private last: number;
  private debt = 0;

  constructor(now: number) {
    this.last = now;
  }

  // Ticks due at now (ms) running at rate ticks per second; long gaps (hidden tab) are capped at a quarter second.
  advance(now: number, rate: number): number {
    const elapsed = Math.min(0.25, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.debt += elapsed * rate;
    const ticks = Math.floor(this.debt);
    this.debt -= ticks;
    return ticks;
  }

  // Restarts from now with nothing carried, e.g. while paused.
  reset(now: number): void {
    this.last = now;
    this.debt = 0;
  }
}
