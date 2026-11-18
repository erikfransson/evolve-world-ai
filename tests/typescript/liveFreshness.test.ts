// @vitest-environment happy-dom
import { EVERY_MS, MAX_BYTES, MIN_GAP_MS, TIMEOUT_MS, VERSION_URL, fetchNewerVersion, isNewer, parseVersionFile, readCapped, shouldCheck, versionFileText, watchFreshness } from "../../src/typescript/src/live/freshness.ts";

const stream = (bytes: number, chunk = 64): ReadableStream<Uint8Array> => {
  let left = bytes;
  return new ReadableStream({ pull(c) { if (left <= 0) return c.close(); const n = Math.min(chunk, left); left -= n; c.enqueue(new Uint8Array(n).fill(0x20)); } });
};
const reply = (body: string, headers: Record<string, string> = {}, status = 200): Response => new Response(body, { status, headers });

describe("newer page check (version.json)", () => {
  it("accepts only a plain three-part version and compares it numerically", () => {
    expect(parseVersionFile(versionFileText("0.10.3"))).toBe("0.10.3");
    expect(isNewer("0.10.3", "0.10.2")).toBe(true);
    expect(isNewer("0.11.0", "0.10.12")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.10.2", "0.10.2")).toBe(false);
    expect(isNewer("0.10.1", "0.10.2")).toBe(false);
    expect(isNewer("0.9.9", "0.10.0")).toBe(false);
  });

  it("rejects malformed, oversized or decorated input", () => {
    const bad = ["", "nope", "null", "5", '"0.10.3"', "[]", '{"version":0.1}', '{"version":"0.10"}', '{"version":"0.10.3.1"}', '{"version":"v0.10.3"}', '{"version":"0.10.3 "}', '{"version":"0.10.3<b>"}',
      '{"version":"<img src=x onerror=alert(1)>"}', '{"version":"99999.0.0"}', '{"v":"0.10.3"}', `{"version":"0.10.3","pad":"${"x".repeat(MAX_BYTES)}"}`];
    for (const t of bad) expect(parseVersionFile(t)).toBeNull();
  });

  it("reads at most MAX_BYTES of a body", async () => {
    expect(await readCapped(stream(MAX_BYTES))).toBe(" ".repeat(MAX_BYTES));
    expect(await readCapped(stream(1 << 20))).toBeNull();
    let cancelled = 0;
    let pulled = 0;
    const big = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(64)); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
    expect(await readCapped(big)).toBeNull();
    expect(cancelled).toBe(1); // the rest is not downloaded
    expect(pulled).toBeLessThanOrEqual(5);
    expect(await readCapped(null)).toBeNull();
  });

  it("asks the fixed relative URL without cache, and every failure is silent", async () => {
    const calls: [unknown, RequestInit | undefined][] = [];
    const f = (body: () => Response | Promise<Response>) => ((url: unknown, init?: RequestInit) => { calls.push([url, init]); return Promise.resolve().then(body); }) as typeof fetch;
    expect(await fetchNewerVersion(f(() => reply('{"version":"0.10.3"}')), "0.10.2")).toBe("0.10.3");
    expect(calls[0]![0]).toBe(VERSION_URL);
    expect(VERSION_URL).toBe("version.json");
    expect(calls[0]![1]).toMatchObject({ cache: "no-store", redirect: "error", credentials: "same-origin" });
    expect(calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
    expect(await fetchNewerVersion(f(() => reply('{"version":"0.10.2"}')), "0.10.2")).toBeNull();
    expect(await fetchNewerVersion(f(() => reply('{"version":"0.10.1"}')), "0.10.2")).toBeNull();
    expect(await fetchNewerVersion(f(() => reply('{"version":"0.10.3"}', {}, 404)), "0.10.2")).toBeNull();
    expect(await fetchNewerVersion(f(() => reply('{"version":"0.10.3"}', { "content-length": "100000" })), "0.10.2")).toBeNull();
    expect(await fetchNewerVersion(f(() => new Response(stream(1 << 20))), "0.10.2")).toBeNull();
    expect(await fetchNewerVersion(f(() => reply("{oops")), "0.10.2")).toBeNull();
    expect(await fetchNewerVersion(f(() => { throw new TypeError("offline"); }), "0.10.2")).toBeNull();
  });

  it("asks every 30 minutes at most, a shown tab at most every 5, a hidden tab never", () => {
    expect(shouldCheck(EVERY_MS - 1, 0, false, "tick")).toBe(false);
    expect(shouldCheck(EVERY_MS, 0, false, "tick")).toBe(true);
    expect(shouldCheck(EVERY_MS, 0, true, "tick")).toBe(false);
    expect(shouldCheck(MIN_GAP_MS - 1, 0, false, "visible")).toBe(false);
    expect(shouldCheck(MIN_GAP_MS, 0, false, "visible")).toBe(true);
    expect(shouldCheck(MIN_GAP_MS, 0, true, "visible")).toBe(false);
  });

  it("flipping visibility 100 times in a minute asks at most once", async () => {
    let t = 0;
    let fetches = 0;
    const f = (() => { fetches++; return Promise.resolve(reply('{"version":"0.0.1"}')); }) as unknown as typeof fetch; // older: the page keeps asking, so only the schedule limits it
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    const button = document.createElement("button");
    button.hidden = true;
    const stop = watchFreshness(button, f, () => t);
    t = MIN_GAP_MS; // the first flip after the gap may ask, the next 99 within the minute may not
    for (let i = 0; i < 100; i++) {
      hidden = i % 2 === 0;
      t += 600;
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((r) => setTimeout(r, 0)); // each answer lands before the next flip
    }
    expect(fetches).toBe(1);
    expect(button.hidden).toBe(true);
    stop();
  });

  it("shows fixed text once a newer page is out, and then stops asking", async () => {
    let t = 0;
    let fetches = 0;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    const f = (() => { fetches++; return Promise.resolve(reply('{"version":"99.0.0"}')); }) as unknown as typeof fetch;
    const button = document.createElement("button");
    button.hidden = true;
    const stop = watchFreshness(button, f, () => t);
    t = MIN_GAP_MS;
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(button.hidden).toBe(false);
    expect(button.textContent).toBe("New version · Reload");
    t += 10 * EVERY_MS;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetches).toBe(1);
    stop();
  });

  it("a hostile version string never reaches the button", async () => {
    const button = document.createElement("button");
    button.hidden = true;
    let t = 0;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    const f = (() => Promise.resolve(reply('{"version":"<img src=x onerror=alert(1)>"}'))) as unknown as typeof fetch;
    const stop = watchFreshness(button, f, () => t);
    t = MIN_GAP_MS;
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(button.hidden).toBe(true);
    expect(button.textContent).toBe("");
    expect(button.querySelector("img")).toBeNull();
    stop();
  });

  it("gives up at the timeout and aborts a request that never answers", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const f = ((_u: unknown, init?: RequestInit) => { signal = init?.signal ?? undefined; return new Promise<Response>(() => {}); }) as typeof fetch; // ignores the signal too
      let result: string | null | undefined;
      void fetchNewerVersion(f, "0.10.2").then((v) => { result = v; });
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toBeNull();
      expect(signal!.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks one request at a time: a second trigger while one is pending does not ask again", async () => {
    let t = 0;
    let fetches = 0;
    let answer: (r: Response) => void = () => {};
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    const f = (() => { fetches++; return new Promise<Response>((r) => { answer = r; }); }) as unknown as typeof fetch;
    const button = document.createElement("button");
    button.hidden = true;
    const stop = watchFreshness(button, f, () => t);
    t = MIN_GAP_MS;
    document.dispatchEvent(new Event("visibilitychange"));
    t = 3 * MIN_GAP_MS; // past the gap again, the first still pending
    document.dispatchEvent(new Event("visibilitychange"));
    expect(fetches).toBe(1);
    answer(reply('{"version":"0.0.1"}'));
    stop();
  });

  it("never reloads by itself: only a click on the shown button reloads", async () => {
    let t = 0;
    let reloads = 0;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
    const f = (() => Promise.resolve(reply('{"version":"99.0.0"}'))) as unknown as typeof fetch;
    const button = document.createElement("button");
    button.hidden = true;
    const stop = watchFreshness(button, f, () => t, () => { reloads++; });
    t = MIN_GAP_MS;
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(button.hidden).toBe(false);
    expect(reloads).toBe(0);
    button.click();
    expect(reloads).toBe(1);
    stop();
  });

  it("the minute tick asks after 30 minutes of a visible tab, not before, and never while hidden", async () => {
    vi.useFakeTimers();
    try {
      let fetches = 0;
      let hidden = false;
      Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
      const f = (() => { fetches++; return Promise.resolve(reply('{"version":"0.0.1"}')); }) as unknown as typeof fetch;
      const button = document.createElement("button");
      button.hidden = true;
      const stop = watchFreshness(button, f, () => Date.now());
      await vi.advanceTimersByTimeAsync(EVERY_MS - 60_000);
      expect(fetches).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetches).toBe(1);
      hidden = true;
      await vi.advanceTimersByTimeAsync(3 * EVERY_MS);
      expect(fetches).toBe(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a wall clock set backwards does not stall the schedule (the default clock is monotonic)", async () => {
    const wall = vi.spyOn(Date, "now");
    const mono = vi.spyOn(performance, "now");
    try {
      let fetches = 0;
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      const f = (() => { fetches++; return Promise.resolve(reply('{"version":"0.0.1"}')); }) as unknown as typeof fetch;
      const button = document.createElement("button");
      button.hidden = true;
      wall.mockReturnValue(2_000_000_000_000);
      mono.mockReturnValue(1_000);
      const stop = watchFreshness(button, f);
      wall.mockReturnValue(2_000_000_000_000 - 24 * 3600_000); // the wall clock jumps a day back
      mono.mockReturnValue(1_000 + MIN_GAP_MS);
      document.dispatchEvent(new Event("visibilitychange"));
      expect(fetches).toBe(1);
      stop();
    } finally {
      wall.mockRestore();
      mono.mockRestore();
    }
  });
});
