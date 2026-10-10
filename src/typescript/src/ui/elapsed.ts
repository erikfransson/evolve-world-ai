// Compact elapsed time for on-screen timers: "35s", "2m 35s", "1h 35m 48s", "1d 4h 3m". Fractions are dropped.
export function formatElapsed(seconds: number): string {
  const t = Math.floor(Math.max(0, seconds) || 0);
  const d = Math.floor(t / 86400);
  const h = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
