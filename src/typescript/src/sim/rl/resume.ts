// Checks for resuming a saved training state: every number finite, the saved settings the same as this run's.

// JSON writes NaN and Infinity as null, which loads back as 0, so a state is checked on load.
export function assertFinite(what: string, values: ArrayLike<number> | number | null | undefined): void {
  const bad = values === null || values === undefined || typeof values === "number" ? !Number.isFinite(values) : Array.prototype.some.call(values, (v: unknown) => typeof v !== "number" || !Number.isFinite(v));
  if (bad) throw new Error(`saved state has a non-finite ${what}`);
}

// Throws naming the settings that differ (compared as JSON, so a number written and read back is equal).
export function assertSameSettings(saved: unknown, now: unknown): void {
  const a = (saved ?? {}) as Record<string, unknown>;
  const b = JSON.parse(JSON.stringify(now)) as Record<string, unknown>;
  const differ = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  if (differ.length) throw new Error(`cannot resume: the saved run had other settings (${differ.map((k) => `${k}: saved ${JSON.stringify(a[k])}, now ${JSON.stringify(b[k])}`).join("; ")})`);
}
