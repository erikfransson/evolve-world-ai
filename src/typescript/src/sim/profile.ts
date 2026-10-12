// User CPU ms of the process per named phase, from laps (ecoBench --profile). Attached to an Ecosystem only when profiling.
// Falls back to wall time where process.cpuUsage is missing (browsers).
type CpuProcess = { cpuUsage(): { user: number } };

const cpuMs = (): number => {
  const proc = (globalThis as { process?: CpuProcess }).process;
  return proc?.cpuUsage ? proc.cpuUsage().user / 1000 : performance.now();
};

export class PhaseTimer {
  readonly ms = new Map<string, number>();
  private last = 0;

  start(): void {
    this.last = cpuMs();
  }

  // Adds the time since the previous start or lap to name.
  lap(name: string): void {
    const now = cpuMs();
    this.ms.set(name, (this.ms.get(name) ?? 0) + now - this.last);
    this.last = now;
  }

  reset(): void {
    this.ms.clear();
  }
}
