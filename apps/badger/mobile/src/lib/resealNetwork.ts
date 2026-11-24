/**
 * ACCT-KEYCHG-05: a key change downloads and uploads every media file again, so on a phone the copying waits while it
 * is on mobile data, unless the user turns on "Use mobile data". The network type is the download engine's (the one
 * network signal the app ships, see networkListener.ts); without that engine (tests, a build without it) nothing waits.
 */
import { downloadsNativeAvailable, nativeGetStatus, type NetworkType } from "@space/mobile-media-proxy/downloads";

/** How often a paused copy looks at the network again. */
export const RESEAL_NETWORK_POLL_MS = 3000;

export type ResealNetworkGate = {
  /** Awaited before each file: holds while on mobile data and not allowed; resolves at once when `signal` aborts. */
  beforeFile(signal: AbortSignal): Promise<void>;
  setUseMobileData(allowed: boolean): void;
  /** True while a file waits for Wi-Fi (the screen says so). */
  paused(): boolean;
  subscribe(listener: () => void): () => void;
};

const engineNetworkType = async (): Promise<NetworkType | null> => {
  if (!downloadsNativeAvailable()) return null;
  return await nativeGetStatus()
    .then((status) => status.networkType)
    .catch(() => null);
};

export const createResealNetworkGate = (
  readNetworkType: () => Promise<NetworkType | null> = engineNetworkType,
  pollMs: number = RESEAL_NETWORK_POLL_MS
): ResealNetworkGate => {
  let useMobileData = false;
  let isPaused = false;
  let wake: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const setPaused = (next: boolean) => {
    if (isPaused === next) return;
    isPaused = next;
    for (const listener of listeners) listener();
  };
  const waitOnce = (signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        wake = null;
        resolve();
      };
      const timer = setTimeout(done, pollMs);
      signal.addEventListener("abort", done);
      wake = done;
    });

  return {
    async beforeFile(signal) {
      try {
        while (!signal.aborted && !useMobileData && (await readNetworkType()) === "cellular") {
          setPaused(true);
          await waitOnce(signal);
        }
      } finally {
        setPaused(false);
      }
    },
    setUseMobileData(allowed) {
      useMobileData = allowed;
      wake?.();
    },
    paused: () => isPaused,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
