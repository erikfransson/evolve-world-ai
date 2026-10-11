import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import { MAX_CLIENT_MESSAGE_BYTES, PING } from "../../src/typescript/src/live/protocol.ts";
import type { ServerText } from "../../src/typescript/src/live/protocol.ts";
import { MAX_STRIDE, TokenBucket, frameBudget, gets, sendStride } from "./budget.ts";
import { dropReason } from "./clients.ts";
import type { ClientState } from "./clients.ts";
import { LIMITS } from "./config.ts";
import type { LiveWorld } from "./liveWorld.ts";

const PING_MIN_MS = 200;
export const FRAME_MS = 200;
const FRAME_HZ = 1000 / FRAME_MS;
const ITEMS_EVERY = 10; // frames, so every 2 s

export interface PublicServer {
  http: Server;
  viewers(): number;
  forgetFrames(): void; // after a load: the cached frames belong to the old world
  close(): void;
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

  const viewers = new Map<WebSocket, ClientState>(); // registered viewers only, not sockets about to be refused
  const accepts = new TokenBucket(limits.acceptsPerSecond, limits.acceptBurst);
  const connectBytes = new TokenBucket(limits.connectBytesPerSecond, limits.connectBytesPerSecond); // catch-up frames for new viewers
  const budget = frameBudget(limits);
  let lastItems: Uint8Array | null = null;
  let lastCreatures: Uint8Array | null = null;
  const perViewer = (): number => (lastCreatures?.length ?? 0) * FRAME_HZ + ((lastItems?.length ?? 0) * FRAME_HZ) / ITEMS_EVERY;
  // Room for one more viewer: under the cap, and all of them at the slowest frame rate stay inside the budget.
  const room = (): boolean => viewers.size < limits.maxViewers && ((viewers.size + 1) * perViewer()) / MAX_STRIDE <= budget;

  // Floods past the accept rate get a cheap 503 before the upgrade; a visitor at the cap is upgraded and told "busy", which a browser can show.
  const verifyClient = (_info: { req: IncomingMessage }, done: (ok: boolean, code?: number) => void): void => (accepts.take(1) ? done(true) : done(false, 503));
  // autoPong off: the page's keep-alive is the text "ping", and a flood of ws ping frames must not queue replies.
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_CLIENT_MESSAGE_BYTES, perMessageDeflate: false, autoPong: false, verifyClient });
  wss.on("error", (e) => console.warn("websocket server error:", e.message));
  const sendText = (ws: WebSocket, msg: ServerText): void => ws.send(JSON.stringify(msg));
  // Says why, then drops the socket: terminate, not close, so a refused caller holds nothing open.
  const refuse = (ws: WebSocket): void => ws.send(JSON.stringify({ t: "busy", maxViewers: limits.maxViewers }), () => ws.terminate());

  wss.on("connection", (ws) => {
    ws.on("error", () => ws.terminate());
    if (!room()) return refuse(ws);
    const now = Date.now();
    const client: ClientState = { alive: true, lastMessageAt: now, overSince: 0, windowAt: now, windowCount: 0 };
    viewers.set(ws, client);
    ws.on("close", () => viewers.delete(ws));
    sendText(ws, live.hello(limits.maxViewers));
    ws.send(JSON.stringify(live.stats(viewers.size)));
    const burst = (lastItems?.length ?? 0) + (lastCreatures?.length ?? 0);
    if (burst > 0 && connectBytes.take(burst)) {
      if (lastItems) ws.send(lastItems);
      if (lastCreatures) ws.send(lastCreatures);
    } // else the viewer waits for its turn in the frame loop
    let lastPing = 0;
    // Every frame from the client, of any kind, counts against the message rate.
    const counted = (): void => {
      const t = Date.now();
      if (t - client.windowAt >= 1000) {
        client.windowAt = t;
        client.windowCount = 0;
      }
      if (++client.windowCount > limits.maxClientMessagesPerSecond) ws.terminate();
    };
    ws.on("ping", counted); // not answered, see autoPong
    ws.on("pong", () => {
      client.alive = true;
      counted();
    });
    ws.on("message", (data, isBinary) => {
      counted();
      client.lastMessageAt = Date.now();
      // Only a ping is understood for now.
      if (isBinary || data.toString() !== PING) return;
      const t = Date.now();
      if (t - lastPing < PING_MIN_MS) return;
      lastPing = t;
      sendText(ws, { t: "pong" });
    });
  });

  // Once a second: drop clients that are far behind, silent, or did not answer the last heartbeat.
  let lastHeartbeat = Date.now();
  const heartbeat = setInterval(() => {
    const now = Date.now();
    const beat = now - lastHeartbeat >= limits.heartbeatMs;
    if (beat) lastHeartbeat = now;
    for (const [ws, c] of viewers) {
      if (dropReason(ws.bufferedAmount, c, now)) {
        ws.terminate();
        continue;
      }
      if (!beat) continue;
      if (!c.alive) ws.terminate();
      else {
        c.alive = false;
        ws.ping();
      }
    }
  }, 1000);

  const open = (ws: WebSocket): boolean => ws.readyState === ws.OPEN && ws.bufferedAmount < limits.maxBufferedBytes;
  // Text goes to every viewer, without the frame-skip check: a hello after a reseed or load must not be missed.
  const broadcastText = (msg: ServerText, all = false): void => {
    const data = JSON.stringify(msg);
    for (const ws of viewers.keys()) if (all ? ws.readyState === ws.OPEN : open(ws)) ws.send(data);
  };

  // Frames go round-robin to a share of the viewers so that all together stay inside the budget. The stride is not capped:
  // if the frames grow after viewers joined, each gets fewer, and room() turns new viewers away until it is back at MAX_STRIDE.
  function sendFrames(creatures: Uint8Array, items: Uint8Array | null, frameNo: number, itemNo: number): void {
    const stride = sendStride(viewers.size, perViewer(), budget);
    let i = 0;
    for (const ws of viewers.keys()) {
      const k = i++;
      if (!open(ws)) continue;
      if (items && gets(k, itemNo, stride)) ws.send(items);
      if (gets(k, frameNo, stride)) ws.send(creatures);
    }
  }

  live.onReseed = () => broadcastText(live.hello(limits.maxViewers), true); // new world: ids and scene start over
  let frames = 0;
  const frameLoop = setInterval(() => {
    lastCreatures = live.creatureFrame();
    const items = frames % ITEMS_EVERY === 0 ? (lastItems = live.itemsFrame()) : null;
    sendFrames(lastCreatures, items, frames, Math.floor(frames / ITEMS_EVERY));
    frames++;
  }, FRAME_MS);
  const statsLoop = setInterval(() => broadcastText(live.stats(viewers.size)), limits.statsEveryMs);

  http.listen(port, host);
  return {
    http,
    viewers: () => viewers.size,
    forgetFrames: () => {
      lastItems = null;
      lastCreatures = null;
    },
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
