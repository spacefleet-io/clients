/**
 * Renderer-side connectivity hook backed by `navigator.onLine` and the
 * `online`/`offline` window events, shared by Badger and Parrot desktop.
 * Desktop equivalent of apps/badger/mobile/src/lib/networkListener.ts — kept tiny because the
 * browser already exposes the signal we need; no native module loading.
 *
 * Returns `true` when the OS reports network is available, `false` when it
 * doesn't. Note that `navigator.onLine` is a coarse signal (it only knows
 * about *physical* link state, not reachability), but it is what the desktop
 * gets without a runtime ping. Treat the resulting "offline" banner as a
 * hint, not as a ground truth — the renderer should still attempt API calls
 * and react to their failures.
 */
import { useEffect, useState } from "react";

const readInitialOnline = (): boolean => {
  if (typeof navigator === "undefined") return true;
  if (typeof navigator.onLine !== "boolean") return true;
  return navigator.onLine;
};

export const useOnline = (): boolean => {
  const [online, setOnline] = useState<boolean>(readInitialOnline);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    // Re-read in case state changed between initial render and effect mount.
    setOnline(readInitialOnline());

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return online;
};
