// Structural types for the host capabilities this package needs. They are declared here (not taken from DOM,
// Node or React Native typings) so the same source type-checks in the Electron renderer, Hermes and Bun/Node.
// The global `fetch` and `setTimeout` of every one of those runtimes are assignable to them.

/** Async key-value store the app supplies (localStorage wrapper, electron store, AsyncStorage, a file). */
export interface KeyValueStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface FetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
  /** Set to "omit" on every lookup: no cookie, no HTTP auth state travels with it. */
  credentials?: "omit";
}

export interface FetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponse>;

/** Injectable timers; the handle is opaque. */
export interface Timers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Minimal AbortSignal shape (the real one is assignable). */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/** Uniform random number in [0, 1). */
export type RandomFn = () => number;

type TimerGlobals = {
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  crypto?: { getRandomValues?: (array: Uint32Array) => Uint32Array };
};

// The runtime's globals, typed loosely so this file needs neither DOM, Node nor React Native typings.
const host = globalThis as unknown as TimerGlobals;

/** Longest delay setTimeout accepts (2^31 - 1 ms, about 24.8 days); larger values fire at once in every runtime. */
export const MAX_TIMER_MS = 2_147_483_647;

/** Default timers: the global setTimeout, with the handle unref'd where the runtime has `unref` (Node, Bun) so it never keeps a process alive. */
export const defaultTimers: Timers = {
  setTimeout(callback, delayMs) {
    if (typeof host.setTimeout !== "function") throw new Error("metadata-client: no global setTimeout; pass timers explicitly");
    const handle = host.setTimeout(callback, Math.min(delayMs, MAX_TIMER_MS));
    if (typeof handle === "object" && handle !== null && "unref" in handle && typeof handle.unref === "function") handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    host.clearTimeout?.(handle);
  },
};

/**
 * Default RNG for jitter: crypto.getRandomValues when the runtime has it, Math.random otherwise.
 * Not a secret (the ticket material itself is drawn by `@space/privacy-pass`), but crypto is preferred.
 */
export const defaultRandom: RandomFn = () => {
  const crypto = host.crypto;
  if (typeof crypto?.getRandomValues === "function") return crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000;
  return Math.random();
};

const MAX_RETRY_AFTER_SECONDS = 31_536_000;

/** Parses a Retry-After header (delta seconds or HTTP date) into whole seconds >= 0; undefined when absent or unreadable. */
export function parseRetryAfterSeconds(header: string | null | undefined, nowMs: number): number | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (/^\d+$/u.test(value)) return Math.min(Number(value), MAX_RETRY_AFTER_SECONDS);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(0, Math.ceil((at - nowMs) / 1000)), MAX_RETRY_AFTER_SECONDS);
}
