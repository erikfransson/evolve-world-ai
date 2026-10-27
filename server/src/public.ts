import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { creatureFrameBytes, parseClientMessage } from "../../src/typescript/src/live/protocol.ts";
import { ADD_PREFIX, MAX_ADD_BYTES, parseAdd } from "../../src/typescript/src/live/add.ts";
import type { Added, Refused } from "../../src/typescript/src/live/add.ts";
import { AddGate, AddPolicy, visitorKey } from "./adds.ts";
import type { AddPace } from "./adds.ts";
import type { Rules, ServerText } from "../../src/typescript/src/live/protocol.ts";
import { MAX_STRIDE, RESYNC_S, RESYNC_SHARE, TokenBucket, fits, frameBudget, gets, sendStride } from "./budget.ts";
import { dropReason } from "./clients.ts";
import { ItemFeed } from "./itemFeed.ts";
import type { ClientState } from "./clients.ts";
import { LIMITS, TRUST_FORWARDED } from "./config.ts";
import type { LiveWorld } from "./liveWorld.ts";

const PING_MIN_MS = 200;
export const FRAME_MS = 200;
const FRAME_HZ = 1000 / FRAME_MS;

export interface PublicServer {
  http: Server;
  viewers(): number;
  forgetFrames(): void; // after a load: the cached frames belong to the old world
  sentBytes(): { frames: number; items: number; details: number; text: number }; // totals since start, for tests and measurements
  close(): void;
}

interface Viewer {
  c: ClientState;
  ready: boolean; // its hello has gone out; nothing else is sent before
  lastFrame: number; // number of the last frame whose items it has, -1 before the first or after a new world: it needs the full item set
  selected: number | null; // the creature it follows
  want: number | null | undefined; // a selection asked for past the select rate, applied when the rate allows; the last one wins
  genomeSent: boolean;
  details: TokenBucket; // bytes of details and genomes
  selects: TokenBucket;
  historySent: boolean;
  pace: AddPace; // the connection's add rate and strikes (adds.ts)
  visitor: string; // key for the per-visitor add cap: the address when trusted, else this connection
  adding: boolean; // an add waits for the tick in flight
  setBlockedSince: number; // when it first needed a full item set its send queue had no room for, 0 when not
}

// The public side: an http server that upgrades to WebSocket (and answers GET /stats), the viewers, the frame and stats loops and the heartbeat.
// limits: LIMITS, or a variant in tests. gate: the add caps (a test clock in tests). trustForwarded: key visitors on X-Forwarded-For.
export function startPublic(host: string, port: number, live: LiveWorld, limits: typeof LIMITS = LIMITS, gate = new AddGate(), trustForwarded = TRUST_FORWARDED): PublicServer {
  // A socket that never finishes its request (the WebSocket upgrade) is closed after headersTimeoutMs, checked every second.
  const timeouts = { headersTimeout: limits.headersTimeoutMs, requestTimeout: limits.headersTimeoutMs, connectionsCheckingInterval: 1000 };
  // Besides the upgrade, only GET /stats: two small numbers for the landing page, public, rebuilt at most once a statsEveryMs, never the request body.
  const statsGets = new TokenBucket(limits.statsGetsPerSecond, limits.statsGetBurst);
  let statsBody = "";
  let statsAt = -Infinity;
  const http = createServer(timeouts, (req, res) => {
    if (req.method !== "GET" || req.url !== "/stats") return void res.writeHead(426, { connection: "close" }).end();
    if (!statsGets.take(1)) return void res.writeHead(503, { connection: "close", "retry-after": "10" }).end();
    const now = performance.now(); // monotonic, so a clock step cannot freeze the numbers
    try {
      if (now - statsAt >= limits.statsEveryMs) {
        statsBody = JSON.stringify({ creatures: live.eco.population, viewers: viewers.size });
        statsAt = now;
      }
    } catch (e) {
      console.error("stats:", e instanceof Error ? e.message : e);
      return void res.writeHead(503, { connection: "close" }).end();
    }
    res
      .writeHead(200, {
        connection: "close",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(statsBody),
        "cache-control": "public, max-age=10",
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff",
      })
      .end(statsBody);
  });
  http.on("error", (e) => {
    console.error(`public port ${port}: ${e.message}`);
    process.exit(1);
  });

  const viewers = new Map<WebSocket, Viewer>(); // registered viewers only, not sockets about to be refused
  const accepts = new TokenBucket(limits.acceptsPerSecond, limits.acceptBurst);
  const connectBytes = new TokenBucket(limits.connectBytesPerSecond, Math.max(limits.connectBytesPerSecond, limits.connectBurstBytes)); // full item sets and history for new or lagging viewers
  const budget = frameBudget(limits);
  const policy = new AddPolicy(limits, gate);
  let connections = 0; // numbers the connections for their own visitor key
  const sent = { frames: 0, items: 0, details: 0, text: 0 };
  let lastCreatures: Uint8Array | null = null;
  let lastFrameNo = -1;
  const feed = new ItemFeed();
  let deltaBytes = 0; // smoothed bytes of item changes per frame
  let skippedBytes = 0; // size the creature frame would have, while the frame loop skips encoding it for want of viewers
  const strided = (): number => (lastCreatures?.length ?? skippedBytes) * FRAME_HZ;
  const unstrided = (): number => deltaBytes * FRAME_HZ;
  // Room for one more viewer: under the cap, and all of them at the slowest frame rate stay inside the budget.
  const room = (): boolean => viewers.size < limits.maxViewers && fits(viewers.size + 1, strided(), unstrided(), budget, MAX_STRIDE);

  // Floods past the accept rate get a cheap 503 before the upgrade; a visitor at the cap is upgraded and told "busy", which a browser can show.
  const verifyClient = (_info: { req: IncomingMessage }, done: (ok: boolean, code?: number) => void): void => (accepts.take(1) ? done(true) : done(false, 503));
  // autoPong off: the page's keep-alive is the text "ping", and a flood of ws ping frames must not queue replies.
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_ADD_BYTES, perMessageDeflate: false, autoPong: false, verifyClient });
  wss.on("error", (e) => console.warn("websocket server error:", e.message));
  const send = (ws: WebSocket, data: Uint8Array | string, kind: keyof typeof sent): void => {
    ws.send(data);
    sent[kind] += typeof data === "string" ? Buffer.byteLength(data) : data.length;
  };
  const sendText = (ws: WebSocket, msg: ServerText): void => send(ws, JSON.stringify(msg), "text");
  // Says why, then drops the socket: terminate, not close, so a refused caller holds nothing open.
  const refuse = (ws: WebSocket): void => ws.send(JSON.stringify({ t: "busy", maxViewers: limits.maxViewers }), () => ws.terminate());

  const select = (v: Viewer, id: number | null): void => {
    if (v.selected !== null) live.unwatch(v.selected);
    v.selected = id;
    v.genomeSent = false;
    if (id !== null) live.watch(id);
  };
  const forget = (ws: WebSocket): void => {
    const v = viewers.get(ws);
    if (!v) return;
    select(v, null);
    viewers.delete(ws);
  };

  // The world's history, once per viewer, from the connect allowance; tried again each frame until there is room.
  const sendHistory = (ws: WebSocket, v: Viewer): void => {
    if (v.historySent || !v.ready) return;
    const h = live.chronicle.history();
    if (!connectBytes.take(Buffer.byteLength(h))) return;
    v.historySent = true;
    send(ws, h, "text");
  };

  // An add: per connection a burst of add.burst, then one per add.socketEveryS (checked in the message handler); parsed only while the global
  // attempt rate allows; inserted between ticks if the caps (adds.ts) allow. Every outcome gets an added or refused reply.
  const add = (ws: WebSocket, v: Viewer, text: string): void => {
    const reply = (m: Added | Refused): void => {
      if (ws.readyState === ws.OPEN) sendText(ws, m);
    };
    if (v.adding) return reply({ t: "refused", reason: "the last add is still going in" });
    const no = policy.admit();
    if (no) return reply(no);
    const req = parseAdd(text, live.addRules());
    if (typeof req === "string") return reply({ t: "refused", reason: req });
    v.adding = true;
    void live
      .whenIdle(() => {
        const e = live.eco;
        const no = policy.gate.check(v.visitor, req.copies, { aliveAdded: live.aliveAdded(), population: e.population, speed: live.speedForAdds(), paused: live.paused });
        if (no) return no;
        const r = live.addCreatures(req);
        if ("reason" in r) return { t: "refused", reason: r.reason, ...(r.now === false ? {} : { retryS: 10 }) } satisfies Refused;
        policy.gate.record(v.visitor, r.ids.length);
        return { t: "added", ids: r.ids, name: req.name } satisfies Added;
      })
      .then(reply, (e: unknown) => {
        console.error("add:", e instanceof Error ? e.message : e);
        reply({ t: "refused", reason: "the world could not take it, try again later", retryS: 60 });
      })
      .finally(() => (v.adding = false));
  };

  wss.on("connection", (ws, req) => {
    ws.on("error", () => ws.terminate());
    if (!room()) return refuse(ws);
    const now = performance.now();
    const v: Viewer = {
      c: { alive: true, lastMessageAt: now, overSince: 0, windowAt: now, windowCount: 0 },
      ready: false,
      lastFrame: -1,
      setBlockedSince: 0,
      selected: null,
      want: undefined,
      genomeSent: false,
      details: new TokenBucket(limits.detailBytesPerViewer, limits.detailBurstBytes),
      selects: new TokenBucket(limits.selectsPerSecond, limits.selectBurst),
      historySent: false,
      pace: policy.connection(),
      // Without a trusted address each connection counts as a visitor of its own (perVisitor a window); a new connection costs an
      // accept (accepts per second) and a hello wait.
      visitor: visitorKey(req.headers["x-forwarded-for"], trustForwarded) ?? `conn:${++connections}`,
      adding: false,
    };
    viewers.set(ws, v);
    ws.on("close", () => forget(ws));
    // With helper threads this may run after frame jobs queued before it; until it has run (ready), the viewer gets nothing else.
    void live.whenIdle(() => {
      if (ws.readyState !== ws.OPEN) return;
      v.lastFrame = -1;
      v.ready = true;
      sendText(ws, live.hello(limits.maxViewers));
      sendText(ws, live.stats(viewers.size));
      // Catch-up: the full item set and the last creature frame, from the connect allowance; else the frame loop sends them.
      // The set is of now, which may be a few ticks past the frame; the changes in the next delta then repeat, and repeating one gives the same set.
      if (lastCreatures && connectBytes.take(live.itemsSize() + lastCreatures.length)) {
        send(ws, live.itemsFrame(), "items");
        send(ws, lastCreatures, "frames");
        v.lastFrame = lastFrameNo;
      }
      sendHistory(ws, v);
    }).catch(() => ws.terminate());
    let lastPing = -Infinity;
    const c = v.c;
    // Every frame from the client, of any kind, counts against the message rate.
    const counted = (): void => {
      const t = performance.now();
      if (t - c.windowAt >= 1000) {
        c.windowAt = t;
        c.windowCount = 0;
      }
      if (++c.windowCount > limits.maxClientMessagesPerSecond) ws.terminate();
    };
    ws.on("ping", counted); // not answered, see autoPong
    ws.on("pong", () => {
      c.alive = true;
      counted();
    });
    ws.on("message", (data, isBinary) => {
      try {
        counted();
        c.lastMessageAt = performance.now();
        const text = isBinary ? null : data.toString();
        if (text?.startsWith(ADD_PREFIX)) {
          if (!v.ready) return void ws.terminate(); // the page waits for its hello
          const paced = policy.pace(v.pace);
          if (paced === "cut") return void ws.terminate();
          if (paced) return sendText(ws, paced);
          return add(ws, v, text);
        }
        const msg = text === null ? null : parseClientMessage(text);
        if (!msg) return void ws.terminate(); // anything but a ping or a well-formed select
        if (msg.t === "ping") {
          const t = performance.now();
          if (t - lastPing < PING_MIN_MS) return;
          lastPing = t;
          return sendText(ws, { t: "pong" });
        }
        if (msg.id === v.selected) return void (v.want = undefined);
        if (v.selects.take(1)) {
          v.want = undefined;
          select(v, msg.id);
        } else v.want = msg.id; // the frame loop applies it when the rate allows
      } catch {
        ws.terminate();
      }
    });
  });

  // Once a second: drop clients that are far behind, silent, or did not answer the last heartbeat.
  let lastHeartbeat = performance.now();
  const heartbeat = setInterval(() => {
    const now = performance.now();
    const beat = now - lastHeartbeat >= limits.heartbeatMs;
    if (beat) lastHeartbeat = now;
    for (const [ws, v] of viewers) {
      if (dropReason(ws.bufferedAmount, v.c, now) || (v.setBlockedSince && now - v.setBlockedSince > limits.slowDropMs)) {
        ws.terminate(); // the second: a reader too slow to ever take the set it needs
        continue;
      }
      if (!beat) continue;
      if (!v.c.alive) ws.terminate();
      else {
        v.c.alive = false;
        ws.ping();
      }
    }
  }, 1000);

  const open = (ws: WebSocket): boolean => ws.readyState === ws.OPEN && ws.bufferedAmount < limits.maxBufferedBytes;
  // Text goes to every viewer that has its hello, without the frame-skip check: a hello after a reseed or load must not be missed.
  // A viewer whose connect job has not run yet gets its own hello there.
  const broadcastText = (msg: ServerText, all = false): void => {
    const data = JSON.stringify(msg);
    for (const [ws, v] of viewers) if (v.ready && (all ? ws.readyState === ws.OPEN : open(ws))) send(ws, data, "text");
  };

  // Bytes of the frame budget set aside for full item sets of viewers that wait for one (after a reseed or load, or too far behind).
  let resync = 0;

  // Frames go round-robin to a share of the viewers so that all together stay inside the budget. If the frames grow after viewers joined,
  // each gets fewer (down to SLOWEST_STRIDE), and room() turns new viewers away until it is back at MAX_STRIDE.
  // A viewer without the item set gets it from the connect allowance or from a share of the frame budget, the frames slowing down meanwhile;
  // until then it gets creature frames on its turn.
  function sendFrames(creatures: Uint8Array, frameNo: number): void {
    const fullSize = live.itemsSize();
    const setFits = (ws: WebSocket): boolean => ws.bufferedAmount + fullSize + creatures.length <= limits.hardBufferedBytes; // a set past it would get the viewer dropped
    let waiting = 0;
    for (const [ws, v] of viewers) if (v.ready && v.lastFrame < 0 && setFits(ws)) waiting++; // one that has no room holds no share of the budget
    const reserve = waiting ? Math.min(RESYNC_SHARE * budget, (waiting * (fullSize + creatures.length)) / RESYNC_S) : 0;
    resync = waiting ? Math.min(resync + reserve / FRAME_HZ, fullSize + creatures.length + reserve / FRAME_HZ) : 0;
    const stride = sendStride(viewers.size, strided(), unstrided(), budget - reserve, fullSize * FRAME_HZ);
    let items: Uint8Array | null = null;
    const deltas = new Map<number, Uint8Array | null>(); // by the viewer's last frame
    let k = 0;
    for (const [ws, v] of viewers) {
      const turn = k++;
      if (!v.ready || !open(ws)) continue;
      const due = gets(turn, frameNo, stride);
      if (v.lastFrame >= 0) {
        if (!due) continue;
        if (!deltas.has(v.lastFrame)) deltas.set(v.lastFrame, feed.delta(v.lastFrame, frameNo, () => fullSize));
        const delta = deltas.get(v.lastFrame)!;
        if (delta) {
          send(ws, delta, "items");
          send(ws, creatures, "frames");
          v.lastFrame = frameNo;
          continue;
        }
        v.lastFrame = -1; // too far behind for changes: it needs the full set
      }
      const cost = fullSize + (due ? 0 : creatures.length); // off its turn the creature frame that goes with the set is extra
      const fits = setFits(ws); // else it waits for its queue to drain, and is dropped when that takes longer than slowDropMs
      v.setBlockedSince = fits ? 0 : v.setBlockedSince || performance.now();
      let full = fits && connectBytes.take(cost);
      if (fits && !full && resync >= cost) {
        resync -= cost;
        full = true;
      }
      if (full) {
        send(ws, (items ??= live.itemsFrame()), "items");
        v.lastFrame = frameNo;
      }
      if (full || due) send(ws, creatures, "frames");
    }
  }

  // The selected creature's details to each viewer that follows one, from that viewer's own allowance; the genome once, when it fits.
  // A selection held back by the select rate is applied first, when the rate allows.
  function sendDetails(): void {
    for (const v of viewers.values()) {
      if (v.want === undefined || !v.selects.take(1)) continue;
      if (v.want !== v.selected) select(v, v.want);
      v.want = undefined;
    }
    live.refreshWatched();
    const cache = new Map<number, Uint8Array | null>();
    const genomes = new Map<number, Uint8Array | null>();
    for (const [ws, v] of viewers) {
      const id = v.selected;
      if (id === null || !v.ready || !open(ws)) continue;
      if (!cache.has(id)) cache.set(id, live.detail(id));
      const d = cache.get(id)!;
      if (!d) continue;
      const died = d[9] === 0;
      if (v.details.take(d.length)) {
        send(ws, d, "details");
        if (died) select(v, null); // told once, then nothing more
      } else if (died) select(v, null);
      if (died || v.genomeSent || v.selected === null) continue;
      if (!genomes.has(id)) genomes.set(id, live.genome(id));
      const g = genomes.get(id)!;
      if (g && v.details.take(g.length)) {
        send(ws, g, "details");
        v.genomeSent = true;
      }
    }
  }

  live.onReseed = () => {
    // New world: ids and items start over, so every viewer needs a fresh hello, the full item set and its history again.
    feed.clear();
    lastCreatures = null;
    skippedBytes = 0;
    for (const v of viewers.values()) {
      select(v, null);
      v.want = undefined;
      v.lastFrame = -1;
      v.historySent = false;
    }
    broadcastText(live.hello(limits.maxViewers), true);
  };
  // Each loop has at most one job waiting for the tick in flight, so a stalled tick does not pile them up.
  let frames = 0;
  let framePending = false;
  const frameLoop = setInterval(() => {
    if (framePending) return;
    framePending = true;
    void live.whenIdle(() => {
      try {
        // Nobody connected: no creature frame is encoded (the next viewer gets one on the next tick through the lastCreatures === null
        // path), the item changes are still drained and logged so the feed stays whole.
        const watched = viewers.size > 0;
        lastCreatures = watched ? live.creatureFrame() : null;
        skippedBytes = watched ? 0 : creatureFrameBytes(live.eco.population);
        const delta = live.takeDelta();
        feed.push(frames, delta);
        deltaBytes = 0.8 * deltaBytes + 0.2 * (delta?.length ?? 0);
        if (lastCreatures) {
          lastFrameNo = frames;
          sendFrames(lastCreatures, frames);
          sendDetails();
          for (const [ws, v] of viewers) if (!v.historySent && open(ws)) sendHistory(ws, v);
        } else resync = 0;
      } catch (e) {
        console.error("frame loop:", e instanceof Error ? e.message : e);
      } finally {
        frames++; // a failed frame is skipped, never reused: its number may already be in the feed
      }
    }).then(() => (framePending = false), () => (framePending = false));
  }, FRAME_MS);
  let statsNo = 0;
  let statsPending = false;
  let rulesJson = JSON.stringify(live.currentAddRules());
  const statsLoop = setInterval(() => {
    if (statsPending) return;
    statsPending = true;
    void live.whenIdle(() => {
      try {
        broadcastText(live.stats(viewers.size, statsNo++ % limits.recordsEveryS === 0));
        const add = live.currentAddRules();
        const json = JSON.stringify(add);
        if (json !== rulesJson) {
          rulesJson = json;
          broadcastText({ t: "rules", add } satisfies Rules, true);
        }
      } catch (e) {
        console.error("stats loop:", e instanceof Error ? e.message : e);
      }
    }).then(() => (statsPending = false), () => (statsPending = false));
  }, limits.statsEveryMs);

  http.listen(port, host);
  return {
    http,
    viewers: () => viewers.size,
    forgetFrames: () => {
      lastCreatures = null;
      skippedBytes = 0;
      feed.clear();
      for (const v of viewers.values()) v.lastFrame = -1;
    },
    sentBytes: () => ({ ...sent }),
    close: () => {
      clearInterval(heartbeat);
      clearInterval(frameLoop);
      clearInterval(statsLoop);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      http.close();
    },
  };
}
