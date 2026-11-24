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
  awaitsRestart,
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
  /** Back to idle, keeping a latched `mandatory` flag (a server-mandated update is not dismissible), the setting and the user's remind/ignore choices. */
  reset: () => void;
  /** REL-UPD-08: "Remind me later" on the offered version; the main process answers with a `prompt-snoozed` event. */
  remindLater: () => Promise<void>;
  /** REL-UPD-08: "Ignore" the offered version; the main process answers with a `prompt-ignored` event. */
  ignoreVersion: () => Promise<void>;
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
    setState((prev) => (awaitsRestart(prev.phase) ? prev : { ...prev, phase: "checking", errorMessage: null }));
    const result = await updater.check().catch((err: unknown) => ({
      status: "error" as const,
      message: err instanceof Error ? err.message : String(err),
    }));
    // A finished check stamps its time here too, so the Settings section's "checked at" never waits on the event.
    const checkedAt = Date.now();
    switch (result.status) {
      case "available":
        setState((prev) =>
          awaitsRestart(prev.phase) || prev.phase === "downloading" || prev.phase === "installing"
            ? { ...prev, lastCheckedAt: checkedAt }
            : { ...prev, phase: "available", version: result.version, lastCheckedAt: checkedAt },
        );
        return "available";
      case "unsupported":
        setState((prev) => ({ ...prev, phase: "unsupported" }));
        return "unsupported";
      case "error":
        setState((prev) => (awaitsRestart(prev.phase) ? prev : { ...prev, phase: "error", errorMessage: result.message }));
        return "error";
      case "up-to-date":
        setState((prev) => (awaitsRestart(prev.phase) ? prev : { ...prev, phase: "idle", lastCheckedAt: checkedAt }));
        return "idle";
    }
  }, [updater]);

  /**
   * Channel `self`: download, then the `update-downloaded` event moves the phase to `downloaded`. Channel `system`
   * (REL-UPD-07): the same IPC opens the password dialog and runs the package manager; the main process's
   * `system-*` events carry the phase (installing → installed, back to available on a dismissed dialog, error with
   * the reason), so only a bridge failure lands here.
   */
  const download = useCallback(async (): Promise<void> => {
    if (!updater) return;
    setState((prev) =>
      prev.channel === "system"
        ? { ...prev, phase: "installing", errorMessage: null, failure: null, failureDetail: null }
        : { ...prev, phase: "downloading", progress: 0, errorMessage: null },
    );
    const result = await updater.downloadUpdate().catch((err: unknown) => ({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      thrown: true,
    }));
    if (result.ok) return;
    setState((prev) => {
      if (prev.channel !== "system") return { ...prev, phase: "error", errorMessage: result.message ?? "download_failed" };
      // The events already set the phase (installed, available after a dismissed dialog, error with the reason); a
      // thrown bridge call or a refusal before any event did not. "busy" = an install is already running: keep it.
      if (result.message === "busy") return prev;
      if ("thrown" in result || prev.phase === "installing") return { ...prev, phase: "error", errorMessage: result.message ?? "install_failed" };
      return prev;
    });
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
    () =>
      setState((prev) => ({
        ...INITIAL_UPDATER_STATE,
        mandatory: prev.mandatory,
        autoUpdate: prev.autoUpdate,
        remindLater: prev.remindLater,
        ignoredVersion: prev.ignoredVersion,
      })),
    [],
  );

  const remindLater = useCallback(async (): Promise<void> => {
    await updater
      ?.remindLater()
      .catch((err: unknown) => onErrorRef.current?.(err instanceof Error ? err.message : String(err), "remind me later failed"));
  }, [updater]);

  const ignoreVersion = useCallback(async (): Promise<void> => {
    await updater
      ?.ignoreVersion()
      .catch((err: unknown) => onErrorRef.current?.(err instanceof Error ? err.message : String(err), "ignore update failed"));
  }, [updater]);

  return { state, supported: Boolean(updater), check, download, install, setAutoUpdate, runFullUpdate, reset, remindLater, ignoreVersion };
};
