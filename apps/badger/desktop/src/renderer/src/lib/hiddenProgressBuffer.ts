// Issue #25 P19-residual: while external mpv plays, the app window is hidden
// but the progress save still called the library's `setProgress`, which
// rewrote settingsMap / media / mediaDetailsMap on every save and re-rendered
// every library consumer of an invisible window (~22 % renderer CPU).
//
// The playback dialog hands the engine this wrapper instead. While main
// reports the window hidden, each save is persisted with `deferUi` (no React
// state write) and the latest arguments per media/episode are kept; on show
// (or unmount) they are replayed once through the normal path, which applies
// them to library state in one render. Lives in the playback chunk, not in
// the library context, so the AuthenticatedApp entry chunk does not grow.

import { useEffect, useRef, useState } from "react";
import { isAppWindowHidden, subscribeAppWindowVisibility } from "@/lib/appWindowVisibility";
import { rendererLogger } from "@/logger";
import type { ProgressTiming } from "@/lib/libraryDb";

const log = rendererLogger.child({ scope: "hidden-progress" });

type Timing = ProgressTiming | null;
type ProgressArgs = [mediaId: string, pct: number, episodeId?: string | null, timing?: Timing];
export type LibrarySetProgress = (...args: [...ProgressArgs, options?: { deferUi?: boolean }]) => Promise<void>;
/** The engine-facing `setProgress`: same arguments, no `deferUi` (the wrapper decides). */
export type EngineSetProgress = (...args: ProgressArgs) => Promise<void>;

export const createHiddenDeferredProgress = (setProgress: LibrarySetProgress) => {
  const pending = new Map<string, ProgressArgs>();
  let deferredSaves = 0;
  const flush = (reason: string) => {
    if (pending.size === 0) return;
    log.info({ fields: pending.size, deferredSaves, reason }, "applying progress saved while hidden");
    const latest = [...pending.values()];
    pending.clear();
    deferredSaves = 0;
    // On unmount the library may already be closed (signing out, switching libraries): its setProgress rejects with
    // LIBRARY_NOT_READY, and that save is the only one lost. An uncaught rejection reached Bugsink (badger-desktop
    // 0.1.20, 2026-11-20, alert audit #3356 A17).
    for (const args of latest) {
      setProgress(...args).catch((error: unknown) => {
        log.warn({ err: error, reason }, "applying a progress saved while hidden failed");
      });
    }
  };
  return {
    setProgress: (...args: ProgressArgs): Promise<void> => {
      const field = `${args[0]}:${args[2] ?? ""}`;
      if (!isAppWindowHidden()) {
        pending.delete(field);
        return setProgress(...args);
      }
      pending.set(field, args);
      deferredSaves += 1;
      return setProgress(...args, { deferUi: true });
    },
    /** Subscribe to the hidden flag; the returned cleanup applies what is pending. */
    attach: () => {
      const unsubscribe = subscribeAppWindowVisibility((change) => {
        if (!change.hidden) flush(change.reason);
      });
      return () => {
        unsubscribe();
        flush("unmount");
      };
    },
  };
};

/** Stable `setProgress` for the playback engine that keeps library state quiet while hidden. */
export const useHiddenDeferredSetProgress = (setProgress: LibrarySetProgress): EngineSetProgress => {
  const setProgressRef = useRef(setProgress);
  setProgressRef.current = setProgress;
  const [deferred] = useState(() => createHiddenDeferredProgress((...args) => setProgressRef.current(...args)));
  useEffect(() => deferred.attach(), [deferred]);
  return deferred.setProgress;
};
