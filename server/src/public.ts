import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { MAX_CLIENT_MESSAGE_BYTES, parseClientMessage } from "../../src/typescript/src/live/protocol.ts";
import type { ServerText } from "../../src/typescript/src/live/protocol.ts";
import { MAX_STRIDE, RESYNC_S, RESYNC_SHARE, TokenBucket, fits, frameBudget, gets, sendStride } from "./budget.ts";
import { dropReason } from "./clients.ts";
import { ItemFeed } from "./itemFeed.ts";
import type { ClientState } from "./clients.ts";
import { LIMITS } from "./config.ts";
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
}

// The public side: an http server that only upgrades to WebSocket, the viewers, the frame and stats loops and the heartbeat.
// limits: LIMITS, or a variant in tests.
export function startPublic(host: string, port: number, live: LiveWorld, limits: typeof LIMITS = LIMITS): PublicServer {
  // A socket that never finishes its request (the WebSocket upgrade) is closed after headersTimeoutMs, checked every second.
  const timeouts = { headersTimeout: limits.headersTimeoutMs, requestTimeout: limits.headersTimeoutMs, connectionsCheckingInterval: 1000 };
  const http = createServer(timeouts, (_req, res) => res.writeHead(426, { connection: "close" }).end());
  http.on("error", (e) => {
    console.error(`public port ${port}: ${e.message}`);
    process.exit(1);
  });

  const viewers = new Map<WebSocket, Viewer>(); // registered viewers only, not sockets about to be refused
  const accepts = new TokenBucket(limits.acceptsPerSecond, limits.acceptBurst);
  const connectBytes = new TokenBucket(limits.connectBytesPerSecond, limits.connectBytesPerSecond); // full item sets and history for new or lagging viewers
  const budget = frameBudget(limits);
  const sent = { frames: 0, items: 0, details: 0, text: 0 };
  let lastCreatures: Uint8Array | null = null;
  let lastFrameNo = -1;
  const feed = new ItemFeed();
  let deltaBytes = 0; // smoothed bytes of item changes per frame
  const strided = (): number => (lastCreatures?.length ?? 0) * FRAME_HZ;
  const unstrided = (): number => deltaBytes * FRAME_HZ;
  // Room for one more viewer: under the cap, and all of them at the slowest frame rate stay inside the budget.
  const room = (): boolean => viewers.size < limits.maxViewers && fits(viewers.size + 1, strided(), unstrided(), budget, MAX_STRIDE);

  // Floods past the accept rate get a cheap 503 before the upgrade; a visitor at the cap is upgraded and told "busy", which a browser can show.
  const verifyClient = (_info: { req: IncomingMessage }, done: (ok: boolean, code?: number) => void): void => (accepts.take(1) ? done(true) : done(false, 503));
  // autoPong off: the page's keep-alive is the text "ping", and a flood of ws ping frames must not queue replies.
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_CLIENT_MESSAGE_BYTES, perMessageDeflate: false, autoPong: false, verifyClient });
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

  wss.on("connection", (ws) => {
    ws.on("error", () => ws.terminate());
    if (!room()) return refuse(ws);
    const now = Date.now();
    const v: Viewer = {
      c: { alive: true, lastMessageAt: now, overSince: 0, windowAt: now, windowCount: 0 },
      ready: false,
      lastFrame: -1,
      selected: null,
      want: undefined,
      genomeSent: false,
      details: new TokenBucket(limits.detailBytesPerViewer, limits.detailBurstBytes),
      selects: new TokenBucket(limits.selectsPerSecond, limits.selectBurst),
      historySent: false,
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
    let lastPing = 0;
    const c = v.c;
    // Every frame from the client, of any kind, counts against the message rate.
    const counted = (): void => {
      const t = Date.now();
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
        c.lastMessageAt = Date.now();
        const msg = isBinary ? null : parseClientMessage(data.toString());
        if (!msg) return void ws.terminate(); // anything but a ping or a well-formed select
        if (msg.t === "ping") {
          const t = Date.now();
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
  let lastHeartbeat = Date.now();
  const heartbeat = setInterval(() => {
    const now = Date.now();
    const beat = now - lastHeartbeat >= limits.heartbeatMs;
    if (beat) lastHeartbeat = now;
    for (const [ws, v] of viewers) {
      if (dropReason(ws.bufferedAmount, v.c, now)) {
        ws.terminate();
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
    let waiting = 0;
    for (const v of viewers.values()) if (v.ready && v.lastFrame < 0) waiting++;
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
      let full = connectBytes.take(cost);
      if (!full && resync >= cost) {
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
        lastCreatures = live.creatureFrame();
        const delta = live.takeDelta();
        feed.push(frames, delta);
        deltaBytes = 0.8 * deltaBytes + 0.2 * (delta?.length ?? 0);
        lastFrameNo = frames;
        sendFrames(lastCreatures, frames);
        sendDetails();
        for (const [ws, v] of viewers) if (!v.historySent && open(ws)) sendHistory(ws, v);
      } catch (e) {
        console.error("frame loop:", e instanceof Error ? e.message : e);
      } finally {
        frames++; // a failed frame is skipped, never reused: its number may already be in the feed
      }
    }).then(() => (framePending = false), () => (framePending = false));
  }, FRAME_MS);
  let statsNo = 0;
  let statsPending = false;
  const statsLoop = setInterval(() => {
    if (statsPending) return;
    statsPending = true;
    void live.whenIdle(() => {
      try {
        broadcastText(live.stats(viewers.size, statsNo++ % limits.recordsEveryS === 0));
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
