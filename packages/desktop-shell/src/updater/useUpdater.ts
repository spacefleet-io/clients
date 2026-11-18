/**
 * Renderer side of the shared desktop updater: one hook over the preload's `updater` bridge. The state starts from
 * the main process's (`getState`), so a component mounted after a background download still sees `downloaded`, then
 * follows the events through the same reducer the main process uses.
 *
 * The Settings "Check for updates" button and the mandatory-update prompts drive the same pipeline; optional vs
 * mandatory is only how the consuming UI renders `state`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  INITIAL_UPDATER_STATE,
  reduceUpdaterState,
  type UpdaterBridge,
  type UpdaterPhase,
  type UpdaterState,
} from "./types";

export type DesktopUpdaterControls = {
  state: UpdaterState;
  /** False when the window has no updater bridge (web build, tests without preload). */
  supported: boolean;
  check: () => Promise<UpdaterPhase>;
  download: () => Promise<void>;
  install: () => void;
  /** Change the automatic-updates setting in the main process. */
  setAutoUpdate: (enabled: boolean) => Promise<void>;
  /** Check, and when an update is available download it; the user then restarts via `install`. */
  runFullUpdate: () => Promise<void>;
  /** Back to idle, keeping a latched `mandatory` flag (a server-mandated update is not dismissible) and the setting. */
  reset: () => void;
};

export const useDesktopUpdater = (
  updater: UpdaterBridge | undefined,
  onError?: (message: string, context: string) => void,
): DesktopUpdaterControls => {
  const [state, setState] = useState<UpdaterState>(INITIAL_UPDATER_STATE);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!updater) return;
    let live = true;
    const unsubscribe = updater.onEvent((event) => setState((prev) => reduceUpdaterState(prev, event)));
    updater
      .getState()
      .then((initial) => {
        // An event that arrived meanwhile is newer than this snapshot unless we are still at the initial state.
        if (live) setState((prev) => (prev === INITIAL_UPDATER_STATE ? initial : prev));
      })
      .catch((err: unknown) => onErrorRef.current?.(err instanceof Error ? err.message : String(err), "get state failed"));
    return () => {
      live = false;
      unsubscribe();
    };
  }, [updater]);

  const check = useCallback(async (): Promise<UpdaterPhase> => {
    if (!updater) {
      setState((prev) => ({ ...prev, phase: "unsupported" }));
      return "unsupported";
    }
    setState((prev) => (prev.phase === "downloaded" ? prev : { ...prev, phase: "checking", errorMessage: null }));
    const result = await updater.check().catch((err: unknown) => ({
      status: "error" as const,
      message: err instanceof Error ? err.message : String(err),
    }));
    // A finished check stamps its time here too, so the Settings section's "checked at" never waits on the event.
    const checkedAt = Date.now();
    switch (result.status) {
      case "available":
        setState((prev) =>
          prev.phase === "downloaded" || prev.phase === "downloading"
            ? { ...prev, lastCheckedAt: checkedAt }
            : { ...prev, phase: "available", version: result.version, lastCheckedAt: checkedAt },
        );
        return "available";
      case "unsupported":
        setState((prev) => ({ ...prev, phase: "unsupported" }));
        return "unsupported";
      case "error":
        setState((prev) => (prev.phase === "downloaded" ? prev : { ...prev, phase: "error", errorMessage: result.message }));
        return "error";
      case "up-to-date":
        setState((prev) => (prev.phase === "downloaded" ? prev : { ...prev, phase: "idle", lastCheckedAt: checkedAt }));
        return "idle";
    }
  }, [updater]);

  const download = useCallback(async (): Promise<void> => {
    if (!updater) return;
    setState((prev) => ({ ...prev, phase: "downloading", progress: 0, errorMessage: null }));
    const result = await updater.downloadUpdate().catch((err: unknown) => ({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    }));
    // Success: the `update-downloaded` event moves the phase to `downloaded`.
    if (!result.ok) setState((prev) => ({ ...prev, phase: "error", errorMessage: result.message ?? "download_failed" }));
  }, [updater]);

  const install = useCallback((): void => {
    updater?.installAndRestart().catch((err: unknown) => onErrorRef.current?.(err instanceof Error ? err.message : String(err), "install failed"));
  }, [updater]);

  const setAutoUpdate = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (!updater) return;
      setState((prev) => ({ ...prev, autoUpdate: enabled }));
      await updater
        .setAutoUpdate(enabled)
        .catch((err: unknown) => onErrorRef.current?.(err instanceof Error ? err.message : String(err), "set automatic updates failed"));
    },
    [updater],
  );

  const runFullUpdate = useCallback(async (): Promise<void> => {
    if ((await check()) === "available") await download();
  }, [check, download]);

  const reset = useCallback(
    () => setState((prev) => ({ ...INITIAL_UPDATER_STATE, mandatory: prev.mandatory, autoUpdate: prev.autoUpdate })),
    [],
  );

  return { state, supported: Boolean(updater), check, download, install, setAutoUpdate, runFullUpdate, reset };
};
