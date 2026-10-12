export const MAX_STRIDE = 5; // new viewers are let in only while each viewer would still get every 5th frame, 1 s apart at 5 Hz

export const SLOWEST_STRIDE = 25; // the stride never goes past this (a frame each 5 s), whatever the cost; room() keeps it rare
export const RESYNC_SHARE = 0.5; // of the frame budget, at most this goes to full item sets while viewers wait for one
export const RESYNC_S = 2; // full sets for the waiting viewers are spread over about this long

// Bytes per second for frames: the upload budget less what connect catch-ups, text (stats, hello, pong) and selected-creature details may use.
export function frameBudget(limits: { maxSendBytesPerSecond: number; connectBytesPerSecond: number; maxViewers: number; textBytesPerViewer: number; detailBytesPerViewer: number }): number {
  return limits.maxSendBytesPerSecond - limits.connectBytesPerSecond - limits.maxViewers * (limits.textBytesPerViewer + limits.detailBytesPerViewer);
}

// How many frames apart each viewer's updates are, so that all viewers together stay inside the upload budget.
// strided: bytes per second of a viewer's frames at every frame (creatures), shared by the stride. unstrided: bytes per second each viewer
// gets whatever its stride (item changes, which add up between its frames). full: bytes per second of a full item set at every frame.
// When the item changes alone pass the budget, a viewer's changes cost at most a full set per frame it gets, so those are shared like the frames.
// Never more than SLOWEST_STRIDE.
export function sendStride(viewers: number, strided: number, unstrided: number, budgetBytesPerSecond: number, full = strided): number {
  if (viewers <= 0 || strided <= 0) return 1;
  const left = budgetBytesPerSecond - viewers * unstrided;
  const s = left > 0 ? Math.ceil((viewers * strided) / left) : Math.ceil((viewers * (strided + full)) / budgetBytesPerSecond);
  return Number.isFinite(s) && s > 0 ? Math.min(SLOWEST_STRIDE, Math.max(1, s)) : SLOWEST_STRIDE;
}

// Room for this many viewers when each gets every maxStride-th frame.
export const fits = (viewers: number, strided: number, unstrided: number, budgetBytesPerSecond: number, maxStride: number): boolean =>
  viewers * (strided / maxStride + unstrided) <= budgetBytesPerSecond;

// Round-robin: of every `stride` frames a viewer gets one, and neighbouring viewers get different ones, so the load is level.
export const gets = (viewerIndex: number, frameNo: number, stride: number): boolean => (frameNo + viewerIndex) % stride === 0;

// Allows `rate` units per second on average and up to `burst` at once.
export class TokenBucket {
  private tokens: number;
  private at: number;
  private readonly rate: number;
  private readonly burst: number;
  private readonly now: () => number;

  constructor(rate: number, burst: number, now: () => number = () => performance.now() / 1000) {
    this.rate = rate;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.at = now();
  }

  take(n: number): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + (t - this.at) * this.rate);
    this.at = t;
    if (n > this.tokens) return false;
    this.tokens -= n;
    return true;
  }
}
