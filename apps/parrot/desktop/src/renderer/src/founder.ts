/**
 * WAIT-FOUND-04 on Parrot desktop: the founder status behind the one-time banner and the settings badge. The token
 * lives in main, so both routes go through the bridge; the signed-in account's id keys the session.
 */
import { useMemo } from "react";
import { useFounderStatus, type FounderStatusState } from "@space/ui/founder";
import type { ParrotBridge } from "../../shared/ipc";

type FounderBridge = Pick<ParrotBridge, "getFounderStatus" | "markFounderNoticeSeen">;

export function useParrotFounderStatus(bridge: FounderBridge | undefined, userId: string | null): FounderStatusState {
  const source = useMemo(() => {
    if (!userId || typeof bridge?.getFounderStatus !== "function" || typeof bridge.markFounderNoticeSeen !== "function") return null;
    return {
      key: userId,
      getStatus: async () => {
        const read = await bridge.getFounderStatus();
        return read.ok ? read.status : null;
      },
      markSeen: async () => {
        if (!(await bridge.markFounderNoticeSeen())) throw new Error("founder notice seen-mark failed in main");
      },
    };
  }, [bridge, userId]);
  return useFounderStatus(source);
}
