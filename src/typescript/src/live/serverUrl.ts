export const PUBLIC_SERVER = "wss://mars.taila3d3f2.ts.net";
export const DEV_SERVER = "ws://127.0.0.1:8787";

// Local (developing or served from this machine): ?server= if it is a ws:// or wss:// URL, else the local server. Otherwise always the public one, so a crafted link cannot point visitors elsewhere.
export function serverUrl(search: string, local: boolean): string {
  const given = local ? new URLSearchParams(search).get("server") : null;
  if (given) {
    try {
      const u = new URL(given);
      if (u.protocol === "ws:" || u.protocol === "wss:") return u.href;
    } catch {
      // fall through to the default
    }
  }
  return local ? DEV_SERVER : PUBLIC_SERVER;
}

// Seconds to wait before reconnect attempt number `attempt` (0 for the first retry): doubling from 1 s up to 30 s, with up to 25% jitter.
export function retryDelayS(attempt: number, random = Math.random): number {
  return Math.min(30, 2 ** attempt) * (1 + 0.25 * random());
}
