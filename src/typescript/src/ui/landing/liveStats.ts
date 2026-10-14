// The Live World card's numbers, from the server's GET /stats. Anything unexpected shows nothing.
export interface LiveStats {
  creatures: number;
  viewers: number;
}

const MAX_BYTES = 512;

// The stats address for a WebSocket server address: same host, http(s) instead of ws(s).
export function statsUrl(server: string): string {
  const u = new URL(server);
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = "/stats";
  u.search = "";
  u.hash = "";
  return u.href;
}

// Whole numbers in range, or null.
export function parseStats(text: string): LiveStats | null {
  if (text.length > MAX_BYTES) return null;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof j !== "object" || j === null) return null;
  const { creatures, viewers } = j as Record<string, unknown>;
  const ok = (v: unknown, max: number): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
  return ok(creatures, 1e6) && ok(viewers, 1e5) ? { creatures, viewers } : null;
}

export function statsText(s: LiveStats): string {
  const watching = s.viewers > 0 ? ` · ${s.viewers.toLocaleString("en")} watching` : "";
  if (s.creatures === 0) return `No creatures right now, add the first one${watching}`;
  return `${s.creatures.toLocaleString("en")} ${s.creatures === 1 ? "creature" : "creatures"} alive${watching}`;
}

// One request, given up after timeoutMs; null on any failure.
export async function fetchStats(url: string, timeoutMs = 5000): Promise<LiveStats | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), credentials: "omit", referrerPolicy: "no-referrer" });
    if (!r.ok) return null;
    return parseStats(await r.text());
  } catch {
    return null;
  }
}
