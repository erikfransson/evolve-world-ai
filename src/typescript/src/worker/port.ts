// What a pool needs from a worker, implemented for web workers (browserPool) and node worker_threads (nodePool).
export interface Port<In, Out> {
  post(msg: In, transfer?: Transferable[]): void;
  onMessage(callback: (msg: Out) => void): void;
  onError(callback: (error: unknown) => void): void; // any error or unexpected exit
  terminate(): void;
}
