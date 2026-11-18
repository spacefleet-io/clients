/**
 * Tests for the shared renderer hook `useDesktopUpdater` (packages/desktop-shell/src/updater/useUpdater.ts), driven
 * through a fake `UpdaterBridge` (REL-UPD-01). Ported from Badger's former useUpdater suite.
 *
 * Diagnostic logging (tests-log-generously): suite id `use-updater`, phase markers `[use-updater:<test>:<phase>]`,
 * `dump(label)` prints the hook state and the bridge calls before assertions.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INITIAL_UPDATER_STATE,
  type UpdaterBridge,
  type UpdaterCheckResult,
  type UpdaterEvent,
  type UpdaterState,
} from "../src/updater/types";
import { useDesktopUpdater, type DesktopUpdaterControls } from "../src/updater/useUpdater";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const makeBridge = (initial: UpdaterState = INITIAL_UPDATER_STATE) => {
  const listeners = new Set<(event: UpdaterEvent) => void>();
  const bridge = {
    check: vi.fn(async (): Promise<UpdaterCheckResult> => ({ status: "up-to-date" })),
    downloadUpdate: vi.fn(async (): Promise<{ ok: boolean; message?: string }> => ({ ok: true })),
    installAndRestart: vi.fn(async () => ({ ok: true })),
    setAutoUpdate: vi.fn(async (_enabled: boolean) => ({ ok: true })),
    getState: vi.fn(async () => initial),
    onEvent: vi.fn((listener: (event: UpdaterEvent) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    }),
  } satisfies UpdaterBridge;
  const fire = (event: UpdaterEvent) =>
    act(() => {
      for (const listener of listeners) listener(event);
    });
  return { bridge, listeners, fire };
};

type Bridge = ReturnType<typeof makeBridge>;

const mount = async (b: Bridge | null, onError?: (message: string, context: string) => void) => {
  const view = renderHook(() => useDesktopUpdater(b?.bridge, onError));
  // Let the getState() snapshot land.
  await act(async () => {
    await Promise.resolve();
  });
  return view;
};

const dump = (label: string, controls: DesktopUpdaterControls, b: Bridge | null) => {
  console.log(
    `[use-updater:dump] ${label}`,
    JSON.stringify(
      {
        state: controls.state,
        supported: controls.supported,
        listeners: b?.listeners.size ?? null,
        calls: b
          ? Object.fromEntries(Object.entries(b.bridge).map(([name, fn]) => [name, (fn as ReturnType<typeof vi.fn>).mock.calls]))
          : null,
      },
      null,
      2,
    ),
  );
};

const checked = (label: string, controls: () => DesktopUpdaterControls, b: Bridge | null, assertions: () => void) => {
  try {
    assertions();
  } catch (err) {
    dump(`${label}:fail`, controls(), b);
    throw err;
  }
};

afterEach(cleanup);

describe("useDesktopUpdater — state source", () => {
  it("starts idle and reports supported=true with a bridge", async () => {
    const b = makeBridge();
    const { result } = await mount(b);
    console.log("[use-updater:initial] mounted");
    checked("initial", () => result.current, b, () => {
      expect(result.current.state).toEqual(INITIAL_UPDATER_STATE);
      expect(result.current.supported).toBe(true);
      expect(b.bridge.onEvent).toHaveBeenCalledTimes(1);
      expect(b.bridge.getState).toHaveBeenCalledTimes(1);
    });
  });

  // @req REL-UPD-01: a window opened after a background download still offers the restart.
  it("adopts the main process snapshot (getState) — a late window still sees 'downloaded' and the setting", async () => {
    const b = makeBridge({ ...INITIAL_UPDATER_STATE, phase: "downloaded", version: "2.0.0", progress: 100, autoUpdate: true });
    const { result } = await mount(b);
    console.log(`[use-updater:snapshot] state=${JSON.stringify(result.current.state)}`);
    checked("snapshot", () => result.current, b, () => {
      expect(result.current.state).toMatchObject({ phase: "downloaded", version: "2.0.0", autoUpdate: true });
    });
  });

  it("an event that arrives before the snapshot wins over it", async () => {
    let resolveState: (state: UpdaterState) => void = () => undefined;
    const b = makeBridge();
    b.bridge.getState.mockReturnValueOnce(new Promise<UpdaterState>((resolve) => (resolveState = resolve)));
    const { result } = await mount(b);
    b.fire({ kind: "update-available", version: "3.0.0", releaseNotes: null });
    await act(async () => {
      resolveState({ ...INITIAL_UPDATER_STATE, phase: "idle" });
      await Promise.resolve();
    });
    console.log(`[use-updater:event-before-snapshot] state=${JSON.stringify(result.current.state)}`);
    checked("event-before-snapshot", () => result.current, b, () => {
      expect(result.current.state.phase).toBe("available");
      expect(result.current.state.version).toBe("3.0.0");
    });
  });

  it("a failing getState reports through onError", async () => {
    const b = makeBridge();
    b.bridge.getState.mockRejectedValueOnce(new Error("ipc gone"));
    const onError = vi.fn();
    const { result } = await mount(b, onError);
    console.log(`[use-updater:get-state-fails] onError=${JSON.stringify(onError.mock.calls)}`);
    checked("get-state-fails", () => result.current, b, () => {
      expect(onError).toHaveBeenCalledWith("ipc gone", "get state failed");
    });
  });

  it("without a bridge: supported=false, check() answers unsupported", async () => {
    const { result } = await mount(null);
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.check();
    });
    console.log(`[use-updater:no-bridge] outcome=${outcome} state=${JSON.stringify(result.current.state)}`);
    checked("no-bridge", () => result.current, null, () => {
      expect(result.current.supported).toBe(false);
      expect(outcome).toBe("unsupported");
      expect(result.current.state.phase).toBe("unsupported");
    });
  });

  it("unmount unsubscribes from the event channel", async () => {
    const b = makeBridge();
    const view = await mount(b);
    view.unmount();
    console.log(`[use-updater:unmount] listeners=${b.listeners.size}`);
    expect(b.listeners.size).toBe(0);
  });
});

describe("useDesktopUpdater — events", () => {
  it("checking → available (version + notes) → not-available → idle", async () => {
    const b = makeBridge();
    const { result } = await mount(b);
    b.fire({ kind: "checking" });
    const checking = result.current.state.phase;
    b.fire({ kind: "update-available", version: "2.1.0", releaseNotes: "New features!" });
    const available = result.current.state;
    b.fire({ kind: "update-not-available" });
    console.log(`[use-updater:event-chain] checking=${checking} available=${JSON.stringify(available)} end=${result.current.state.phase}`);
    checked("event-chain", () => result.current, b, () => {
      expect(checking).toBe("checking");
      expect(available).toMatchObject({ phase: "available", version: "2.1.0", releaseNotes: "New features!" });
      expect(result.current.state.phase).toBe("idle");
    });
  });

  it("download-progress → downloading with progress; update-downloaded → downloaded at 100", async () => {
    const b = makeBridge();
    const { result } = await mount(b);
    b.fire({ kind: "download-progress", percent: 42 });
    const downloading = result.current.state;
    b.fire({ kind: "update-downloaded", version: "2.1.0" });
    console.log(`[use-updater:download-events] downloading=${JSON.stringify(downloading)} end=${JSON.stringify(result.current.state)}`);
    checked("download-events", () => result.current, b, () => {
      expect(downloading).toMatchObject({ phase: "downloading", progress: 42 });
      expect(result.current.state).toMatchObject({ phase: "downloaded", progress: 100, version: "2.1.0" });
    });
  });

  it("a downloaded update survives later checking / not-available / error events (background re-check)", async () => {
    const b = makeBridge();
    const { result } = await mount(b);
    b.fire({ kind: "update-downloaded", version: "2.1.0" });
    b.fire({ kind: "checking" });
    b.fire({ kind: "update-not-available" });
    b.fire({ kind: "error", message: "offline" });
    b.fire({ kind: "update-available", version: "2.1.0", releaseNotes: null });
    console.log(`[use-updater:downloaded-sticks] state=${JSON.stringify(result.current.state)}`);
    checked("downloaded-sticks", () => result.current, b, () => {
      expect(result.current.state).toMatchObject({ phase: "downloaded", version: "2.1.0", errorMessage: null });
    });
  });

  it("error event → error phase with the message", async () => {
    const b = makeBridge();
    const { result } = await mount(b);
    b.fire({ kind: "error", message: "network timeout" });
    console.log(`[use-updater:event-error] state=${JSON.stringify(result.current.state)}`);
    expect(result.current.state).toMatchObject({ phase: "error", errorMessage: "network timeout" });
  });

  it("mandatory-update latches mandatory, moves idle → available with the latest version", async () => {
    const b = makeBridge();
    const { result } = await mount(b);
    b.fire({ kind: "mandatory-update", latestVersion: "3.0.0", minClientVersion: "2.5.0" });
    console.log(`[use-updater:mandatory-idle] state=${JSON.stringify(result.current.state)}`);
    expect(result.current.state).toMatchObject({ mandatory: true, phase: "available", version: "3.0.0" });
  });

  it("mandatory-update keeps a download in progress and a version already known", async () => {
    const b = makeBridge();
    const { result } = await mount(b);
    b.fire({ kind: "update-available", version: "2.9.0", releaseNotes: null });
    b.fire({ kind: "download-progress", percent: 55 });
    b.fire({ kind: "mandatory-update", latestVersion: "3.0.0", minClientVersion: "2.5.0" });
    console.log(`[use-updater:mandatory-downloading] state=${JSON.stringify(result.current.state)}`);
    expect(result.current.state).toMatchObject({ mandatory: true, phase: "downloading", version: "2.9.0" });
  });
});

describe("useDesktopUpdater — actions", () => {
  it.each<[UpdaterCheckResult, string, Partial<UpdaterState>]>([
    // REL-UPD-05: a finished check stamps lastCheckedAt for Settings' "checked at"; a failed one does not.
    [{ status: "available", version: "2.1.0" }, "available", { phase: "available", version: "2.1.0", lastCheckedAt: expect.any(Number) }],
    [{ status: "up-to-date" }, "idle", { phase: "idle", lastCheckedAt: expect.any(Number) }],
    [{ status: "unsupported" }, "unsupported", { phase: "unsupported", lastCheckedAt: null }],
    [{ status: "error", message: "check failed: 503" }, "error", { phase: "error", errorMessage: "check failed: 503", lastCheckedAt: null }],
  ])("check() with %j answers %s", async (answer, outcomeWanted, stateWanted) => {
    const b = makeBridge();
    b.bridge.check.mockResolvedValueOnce(answer);
    const { result } = await mount(b);
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.check();
    });
    console.log(`[use-updater:check] answer=${JSON.stringify(answer)} outcome=${outcome} state=${JSON.stringify(result.current.state)}`);
    checked("check", () => result.current, b, () => {
      expect(outcome).toBe(outcomeWanted);
      expect(result.current.state).toMatchObject(stateWanted);
    });
  });

  it("check() rejecting answers error with the message", async () => {
    const b = makeBridge();
    b.bridge.check.mockRejectedValueOnce(new Error("ipc closed"));
    const { result } = await mount(b);
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.check();
    });
    console.log(`[use-updater:check-rejects] outcome=${outcome} state=${JSON.stringify(result.current.state)}`);
    expect(outcome).toBe("error");
    expect(result.current.state).toMatchObject({ phase: "error", errorMessage: "ipc closed" });
  });

  it("check() never clobbers a finished download", async () => {
    const b = makeBridge();
    const { result } = await mount(b);
    b.fire({ kind: "update-downloaded", version: "2.0.0" });
    for (const answer of [{ status: "available", version: "2.0.0" }, { status: "up-to-date" }, { status: "error", message: "x" }] as const) {
      b.bridge.check.mockResolvedValueOnce(answer);
      await act(async () => {
        await result.current.check();
      });
      console.log(`[use-updater:check-keeps-downloaded] answer=${JSON.stringify(answer)} state=${JSON.stringify(result.current.state)}`);
      expect(result.current.state.phase, answer.status).toBe("downloaded");
    }
  });

  it("download() shows downloading while in flight; ok:false or a rejection → error", async () => {
    const b = makeBridge();
    let finish: (value: { ok: boolean; message?: string }) => void = () => undefined;
    b.bridge.downloadUpdate.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const { result } = await mount(b);
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.download();
    });
    const inFlight = result.current.state;
    await act(async () => {
      finish({ ok: false, message: "disk full" });
      await pending;
    });
    const failed = result.current.state;
    b.bridge.downloadUpdate.mockRejectedValueOnce(new Error("socket hang up"));
    await act(async () => {
      await result.current.download();
    });
    console.log(`[use-updater:download] inFlight=${JSON.stringify(inFlight)} failed=${JSON.stringify(failed)} end=${JSON.stringify(result.current.state)}`);
    checked("download", () => result.current, b, () => {
      expect(inFlight).toMatchObject({ phase: "downloading", progress: 0 });
      expect(failed).toMatchObject({ phase: "error", errorMessage: "disk full" });
      expect(result.current.state).toMatchObject({ phase: "error", errorMessage: "socket hang up" });
    });
  });

  it("install() calls installAndRestart; a rejection reports through onError", async () => {
    const b = makeBridge();
    const onError = vi.fn();
    b.bridge.installAndRestart.mockRejectedValueOnce(new Error("no update"));
    const { result } = await mount(b, onError);
    await act(async () => {
      result.current.install();
      await Promise.resolve();
    });
    console.log(`[use-updater:install] calls=${b.bridge.installAndRestart.mock.calls.length} onError=${JSON.stringify(onError.mock.calls)}`);
    expect(b.bridge.installAndRestart).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("no update", "install failed");
  });

  // @req REL-UPD-01
  it("setAutoUpdate() updates state.autoUpdate at once and tells the main process", async () => {
    const b = makeBridge({ ...INITIAL_UPDATER_STATE, autoUpdate: true });
    const onError = vi.fn();
    const { result } = await mount(b, onError);
    await act(async () => {
      await result.current.setAutoUpdate(false);
    });
    const off = result.current.state.autoUpdate;
    b.bridge.setAutoUpdate.mockRejectedValueOnce(new Error("ipc closed"));
    await act(async () => {
      await result.current.setAutoUpdate(true);
    });
    console.log(`[use-updater:set-auto] off=${off} end=${result.current.state.autoUpdate} calls=${JSON.stringify(b.bridge.setAutoUpdate.mock.calls)}`);
    checked("set-auto", () => result.current, b, () => {
      expect(off).toBe(false);
      expect(result.current.state.autoUpdate).toBe(true);
      expect(b.bridge.setAutoUpdate.mock.calls).toEqual([[false], [true]]);
      expect(onError).toHaveBeenCalledWith("ipc closed", "set automatic updates failed");
    });
  });

  it("runFullUpdate() downloads only when the check found an update", async () => {
    const b = makeBridge();
    const { result } = await mount(b);
    await act(async () => {
      await result.current.runFullUpdate();
    });
    const afterUpToDate = b.bridge.downloadUpdate.mock.calls.length;
    b.bridge.check.mockResolvedValueOnce({ status: "available", version: "2.0.0" });
    await act(async () => {
      await result.current.runFullUpdate();
    });
    console.log(`[use-updater:run-full] afterUpToDate=${afterUpToDate} downloads=${b.bridge.downloadUpdate.mock.calls.length}`);
    expect(afterUpToDate).toBe(0);
    expect(b.bridge.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it("reset() returns to idle but keeps the latched mandatory flag and the setting", async () => {
    const b = makeBridge({ ...INITIAL_UPDATER_STATE, autoUpdate: true });
    const { result } = await mount(b);
    b.fire({ kind: "mandatory-update", latestVersion: "3.0.0", minClientVersion: "2.5.0" });
    b.fire({ kind: "update-downloaded", version: "3.0.0" });
    act(() => result.current.reset());
    console.log(`[use-updater:reset] state=${JSON.stringify(result.current.state)}`);
    expect(result.current.state).toEqual({ ...INITIAL_UPDATER_STATE, mandatory: true, autoUpdate: true });
  });
});
