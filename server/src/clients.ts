import { LIMITS } from "./config.ts";

export interface ClientState {
  alive: boolean; // a pong came since the last heartbeat ping
  lastMessageAt: number;
  overSince: number; // when the send queue first passed maxBufferedBytes, 0 when below
  windowAt: number;
  windowCount: number;
}

// Why a client should be dropped now, or null. Updates overSince from the send queue.
export function dropReason(bufferedAmount: number, c: ClientState, now: number): string | null {
  if (bufferedAmount > LIMITS.maxBufferedBytes) c.overSince ||= now;
  else c.overSince = 0;
  if (bufferedAmount > LIMITS.hardBufferedBytes) return "send queue over the hard cap";
  if (c.overSince && now - c.overSince > LIMITS.slowDropMs) return "send queue over the frame-skip level for too long";
  if (now - c.lastMessageAt > LIMITS.idleDropMs) return "idle";
  return null;
}
