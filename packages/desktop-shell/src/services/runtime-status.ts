import { useCallback, useEffect, useState } from "react";

type RuntimeBridge = {
  getStatus?: () => Promise<{ status: string }>;
  onStatusChange?: (callback: (payload: { status: string }) => void) => () => void;
  restart?: () => Promise<{ ok: boolean }>;
};

function getRuntimeBridge(): RuntimeBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const sf = (window as unknown as { sf?: { runtime?: RuntimeBridge } }).sf;
  return sf?.runtime;
}

export type RuntimeStatusValue = "ready" | "restarting" | "lost" | "unknown";

export function useRuntimeStatus() {
  const [status, setStatus] = useState<RuntimeStatusValue>("unknown");
  const [restarting, setRestarting] = useState(false);
  const bridge = getRuntimeBridge();
  const available = !!bridge;

  useEffect(() => {
    const b = getRuntimeBridge();
    if (!b?.getStatus || !b.onStatusChange) return;
    b.getStatus()
      .then((res) => setStatus((res.status as RuntimeStatusValue) ?? "unknown"))
      .catch(() => {});
    return b.onStatusChange((payload) => {
      setStatus((payload.status as RuntimeStatusValue) ?? "unknown");
      if (payload.status === "ready") setRestarting(false);
    });
  }, [available]);

  const restart = useCallback(async () => {
    const b = getRuntimeBridge();
    if (!b?.restart) return;
    setRestarting(true);
    try {
      await b.restart();
    } catch {
      setRestarting(false);
    }
  }, [available]);

  return { status, restart, restarting, available };
}

/**
 * Returns a monotonically-increasing counter that bumps every time the
 * runtime transitions to `"ready"` (initial spawn AND every respawn). Wire
 * this into the dependency array of any `useEffect` that establishes
 * per-runtime state on the runtime side (auth attach, key forward, ingest
 * concurrency caps, ...) so the effect refires after the runtime has lost
 * its in-memory state.
 *
 * Counter starts at 0 and reaches 1 on the first ready event. Effects that
 * depend on it should be written so that `runtimeInstanceId === 0` is a
 * legitimate "not ready yet" state; the first bump to 1 will refire them.
 *
 * @bugfix all-newly-added-jobs-cuddly-cookie — Bug B
 */
export function useRuntimeInstanceId(): number {
  const [instanceId, setInstanceId] = useState(0);
  const bridge = getRuntimeBridge();
  const available = !!bridge;

  useEffect(() => {
    const b = getRuntimeBridge();
    if (!b?.onStatusChange) return;
    let lastStatus: RuntimeStatusValue = "unknown";
    // If we boot into a ready runtime, bump once so first-mount effects
    // get a non-zero id without waiting for the next respawn.
    b.getStatus?.()
      .then((res) => {
        const s = (res.status as RuntimeStatusValue) ?? "unknown";
        if (s === "ready") {
          lastStatus = "ready";
          setInstanceId((prev) => prev + 1);
        }
      })
      .catch(() => {});
    return b.onStatusChange((payload) => {
      const next = (payload.status as RuntimeStatusValue) ?? "unknown";
      // Edge-trigger: only bump on a transition INTO "ready". Same-status
      // pings (e.g. repeated "ready" beacons) must not refire dependent
      // effects, otherwise every status broadcast forces an attach.
      if (next === "ready" && lastStatus !== "ready") {
        setInstanceId((prev) => prev + 1);
      }
      lastStatus = next;
    });
  }, [available]);

  return instanceId;
}
