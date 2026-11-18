import { useOnline } from "@space/desktop-shell/hooks";
import { unavailableOffline } from "@space/shared/offlineReach";
import { isOfflineModeFallbackMessage, useLibraryShell } from "@/lib/libraryContext";
import type { OfflineStateRollUp } from "@/lib/offlineState";

/**
 * Whether titles can stream right now: the computer has a network AND the library reached the server. Either one
 * failing is offline, as the offline banner shows (OFFL-PLAY-02); it flips back on its own when the library reconnects.
 */
export const useLibraryOnline = (): boolean => {
  const online = useOnline();
  const { error } = useLibraryShell();
  return online && !isOfflineModeFallbackMessage(error);
};

/**
 * OFFL-PLAY-03: offline, a title with nothing downloaded on this computer is greyed out and does not open or play; a
 * film with its file, or a show with at least one downloaded episode, stays in colour.
 */
export const titleUnavailableOffline = (online: boolean, rollUp: OfflineStateRollUp | undefined): boolean =>
  unavailableOffline(online, (rollUp ?? "none") !== "none");
