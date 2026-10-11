export const MAX_STRIDE = 5; // new viewers are let in only while each viewer would still get every 5th frame, 1 s apart at 5 Hz

// Bytes per second for frames: the upload budget less what connect catch-ups and text (stats, hello, pong) may use.
export function frameBudget(limits: { maxSendBytesPerSecond: number; connectBytesPerSecond: number; maxViewers: number; textBytesPerViewer: number }): number {
  return limits.maxSendBytesPerSecond - limits.connectBytesPerSecond - limits.maxViewers * limits.textBytesPerViewer;
}

// How many frames apart each viewer's updates are, so that all viewers together stay inside the upload budget.
export function sendStride(viewers: number, bytesPerSecondPerViewer: number, budgetBytesPerSecond: number): number {
  if (viewers <= 0 || bytesPerSecondPerViewer <= 0) return 1;
  return Math.max(1, Math.ceil((viewers * bytesPerSecondPerViewer) / budgetBytesPerSecond));
}

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
