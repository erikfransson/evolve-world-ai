import { BRAIN_WASM_BASE64, SENSE_WASM_BASE64, FILL_WASM_BASE64, STEP_WASM_BASE64 } from "./kernels.generated.ts";

// WebAssembly SIMD kernels are optional: callers get null from the create functions when they are unavailable and keep the JS path.

const PAGE = 65536;

function decode(base64: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

export const BRAIN_BYTES = decode(BRAIN_WASM_BASE64);
export const SENSE_BYTES = decode(SENSE_WASM_BASE64);
export const FILL_BYTES = decode(FILL_WASM_BASE64);
export const STEP_BYTES = decode(STEP_WASM_BASE64);

// Compiled modules by their bytes: compiling is most of an instance's cost, and a module holds no state.
const modules = new WeakMap<Uint8Array, WebAssembly.Module>();
export function compiled(bytes: Uint8Array<ArrayBuffer>): WebAssembly.Module {
  let m = modules.get(bytes);
  if (!m) modules.set(bytes, (m = new WebAssembly.Module(bytes)));
  return m;
}

let disabled = false;
let supported: boolean | undefined;

// Forces the JS path (true) or restores detection (false); for tests and for a user-facing switch.
export function setWasmDisabled(flag: boolean): void {
  disabled = flag;
}

// True when this runtime validates both kernels, which need WebAssembly SIMD.
export function wasmAvailable(): boolean {
  if (disabled || typeof WebAssembly !== "object") return false;
  supported ??= WebAssembly.validate(BRAIN_BYTES) && WebAssembly.validate(SENSE_BYTES);
  return supported;
}

// A kernel instance with its linear memory and cached views, refreshed when the memory grows.
export class Kernel<E extends WebAssembly.Exports> {
  readonly exports: E;
  readonly memory: WebAssembly.Memory;
  onGrow: (() => void) | null = null; // called after the memory grew, when every view of it is stale
  private f32Cache = new Float32Array(0);
  private i32Cache = new Int32Array(0);

  private constructor(exports: E) {
    this.exports = exports;
    this.memory = exports.mem as WebAssembly.Memory;
  }

  // Compiled on this thread, once per bytes (RL makes an ecosystem per episode); each kernel still gets its own instance.
  static createSync<E extends WebAssembly.Exports>(bytes: Uint8Array<ArrayBuffer>): Kernel<E> | null {
    if (!wasmAvailable()) return null;
    try {
      return new Kernel(new WebAssembly.Instance(compiled(bytes), {}).exports as E);
    } catch {
      return null;
    }
  }

  get f32(): Float32Array {
    if (this.f32Cache.buffer !== this.memory.buffer) this.f32Cache = new Float32Array(this.memory.buffer);
    return this.f32Cache;
  }

  get i32(): Int32Array {
    if (this.i32Cache.buffer !== this.memory.buffer) this.i32Cache = new Int32Array(this.memory.buffer);
    return this.i32Cache;
  }

  // Grows the memory to at least bytes, by an eighth more than needed so that growing (which replaces every view of it) stays rare.
  ensure(bytes: number): void {
    const have = this.memory.buffer.byteLength;
    if (bytes <= have) return;
    this.memory.grow(Math.ceil((Math.max(bytes, have + have / 8) - have) / PAGE));
    this.onGrow?.();
  }
}

// Byte allocator over a kernel's memory: bump pointer plus free lists by size, 16-byte aligned. Freed blocks are reused for the same rounded size.
export class Arena {
  private top: number;
  private readonly kernel: Kernel<WebAssembly.Exports>;
  private readonly free = new Map<number, number[]>();

  constructor(kernel: Kernel<WebAssembly.Exports>, start: number) {
    this.kernel = kernel;
    this.top = start;
  }

  static round(bytes: number): number {
    return Math.max(256, Math.ceil(bytes / 256) * 256);
  }

  alloc(bytes: number): number {
    const size = Arena.round(bytes);
    const reuse = this.free.get(size)?.pop();
    if (reuse !== undefined) return reuse;
    const ptr = this.top;
    this.kernel.ensure(ptr + size);
    this.top += size;
    return ptr;
  }

  release(ptr: number, bytes: number): void {
    const size = Arena.round(bytes);
    const list = this.free.get(size);
    if (list) list.push(ptr);
    else this.free.set(size, [ptr]);
  }
}
