/**
 * DEV-LIB-01: renderer access to third-party tool grants. Main (main/toolAccessIpc.ts) holds the runtime session;
 * the runtime pushes a snapshot (pending requests + grants) whenever it changes. A pending request carries a
 * verification code and exists only in the runtime's memory, so the snapshot is also fetched on mount and when
 * the window regains focus.
 */
import { useCallback, useEffect, useState } from "react";
import type { ToolAccessMode, ToolAccessSnapshot } from "@space/tool-access/contracts";
import { rendererLogger } from "@/logger";

const log = rendererLogger.child({ scope: "tool-access" });

export type ToolAccessView = {
  snapshot: ToolAccessSnapshot;
  /** Approve (optionally with less access than asked) or deny a pending request. Resolves false when the runtime refused. */
  decide: (requestId: string, decision: "approve" | "deny", mode?: ToolAccessMode) => Promise<boolean>;
  revoke: (grantId: string) => Promise<boolean>;
};

const EMPTY: ToolAccessSnapshot = { pending: [], grants: [] };

/** undefined = no bridge (web build, tests without one). */
export const useToolAccess = (): ToolAccessView | undefined => {
  const bridge = window.sf?.toolAccess;
  const [snapshot, setSnapshot] = useState<ToolAccessSnapshot>(EMPTY);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    const refresh = () => {
      bridge
        .getSnapshot()
        .then((next) => {
          if (!cancelled) setSnapshot(next);
        })
        .catch((err: unknown) => log.warn({ err: String(err) }, "could not read tool access"));
    };
    refresh();
    const unsubscribe = bridge.onUpdate((next) => {
      if (!cancelled) setSnapshot(next);
    });
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, [bridge]);

  // A refused decision (the request expired meanwhile) pushes nothing, so settle by reading the runtime again.
  const resync = useCallback(async () => {
    if (!bridge) return;
    try {
      setSnapshot(await bridge.getSnapshot());
    } catch (err) {
      log.warn({ err: String(err) }, "could not read tool access");
    }
  }, [bridge]);

  const decide = useCallback(
    async (requestId: string, decision: "approve" | "deny", mode?: ToolAccessMode) => {
      if (!bridge) return false;
      let ok = false;
      try {
        ok = (await bridge.decide({ requestId, decision, ...(mode ? { mode } : {}) })).ok;
        log.info({ requestId, decision, mode, ok }, "tool access decision sent");
      } catch (err) {
        log.warn({ err: String(err), requestId }, "could not send tool access decision");
      }
      await resync();
      return ok;
    },
    [bridge, resync],
  );

  const revoke = useCallback(
    async (grantId: string) => {
      if (!bridge) return false;
      let ok = false;
      try {
        ok = (await bridge.revoke(grantId)).ok;
        log.info({ grantId, ok }, "tool access revoked");
      } catch (err) {
        log.warn({ err: String(err), grantId }, "could not revoke tool access");
      }
      await resync();
      return ok;
    },
    [bridge, resync],
  );

  return bridge ? { snapshot, decide, revoke } : undefined;
};
