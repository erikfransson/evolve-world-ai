import { VERSION } from "../version.ts";

// "A newer page is deployed" hint: a tab left open for days asks the build's version.json now and then and offers a reload button.
// The response is hostile data: size-capped, JSON only, a plain version string only, never shown or used as a URL.
export const VERSION_URL = "version.json"; // fixed, next to the Live page on its own origin (written by the build, vite.config.ts)
export const MAX_BYTES = 200;
export const TIMEOUT_MS = 10_000;
export const EVERY_MS = 30 * 60_000; // routine check while the tab is visible
export const MIN_GAP_MS = 5 * 60_000; // a tab shown again checks at most this often
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/; // the same pattern versionLabel.ts accepts from the server

export function versionFileText(version = VERSION): string {
  return `${JSON.stringify({ version })}\n`;
}

// The version from version.json's text, or null for anything else.
export function parseVersionFile(text: string): string | null {
  if (text.length > MAX_BYTES) return null;
  try {
    const v = (JSON.parse(text) as { version?: unknown } | null)?.version;
    return typeof v === "string" && VERSION_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function isNewer(remote: string, page = VERSION): boolean {
  const a = remote.split(".").map(Number);
  const b = page.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

// Whether to ask now. `trigger` is the 30-minute tick or the tab becoming visible; nothing is asked while hidden.
export function shouldCheck(now: number, lastCheck: number, hidden: boolean, trigger: "tick" | "visible"): boolean {
  if (hidden) return false;
  return now - lastCheck >= (trigger === "tick" ? EVERY_MS : MIN_GAP_MS);
}

// The body as text, or null once it passes `max` bytes (the rest is not read).
export async function readCapped(body: ReadableStream<Uint8Array> | null, max = MAX_BYTES): Promise<string | null> {
  if (!body) return null;
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        void reader.cancel().catch(() => {});
        return null;
      }
      parts.push(value);
    }
  } catch {
    return null;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

// One check: the deployed version when it is newer than this page, else null. Every failure is silent, and it settles by TIMEOUT_MS
// even if the fetcher or the body stalls (the race), with the request aborted.
export async function fetchNewerVersion(fetcher: typeof fetch = fetch, page = VERSION): Promise<string | null> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), TIMEOUT_MS);
  });
  const ask = async (): Promise<string | null> => {
    const res = await fetcher(VERSION_URL, { cache: "no-store", credentials: "same-origin", redirect: "error", signal: abort.signal });
    if (!res.ok || Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) return null;
    const text = await readCapped(res.body);
    const v = text === null ? null : parseVersionFile(text);
    return v !== null && isNewer(v, page) ? v : null;
  };
  try {
    return await Promise.race([ask().catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
    abort.abort(); // ends a stalled request and drops a body left unread
  }
}

// Wires the checks to the page: a minute tick and visibilitychange, one request at a time, and `button` shown for good once a newer page is out.
// `now` is monotonic by default, so a wall clock set backwards does not stall the schedule.
export function watchFreshness(button: HTMLButtonElement, fetcher: typeof fetch = fetch, now: () => number = () => performance.now(), reload: () => void = () => location.reload()): () => void {
  let last = now(); // the page was fresh when it loaded
  let busy = false;
  const check = (trigger: "tick" | "visible"): void => {
    if (busy || !button.hidden || !shouldCheck(now(), last, document.hidden, trigger)) return;
    busy = true;
    last = now();
    void fetchNewerVersion(fetcher).then((v) => {
      busy = false;
      if (v === null) return;
      button.textContent = "New version · Reload";
      button.hidden = false;
      stop();
    });
  };
  const tick = setInterval(() => check("tick"), 60_000);
  const onVisible = (): void => check("visible");
  document.addEventListener("visibilitychange", onVisible);
  const stop = (): void => {
    clearInterval(tick);
    document.removeEventListener("visibilitychange", onVisible);
  };
  button.addEventListener("click", () => reload());
  return stop;
}
