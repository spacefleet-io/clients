// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-UPDATES-001
 * @level integration (real updates.tsx over the real shared updater hook and section; `window.parrot.updater` bridge faked)
 * @req REL-UPD-01
 * @req REL-UPD-02
 * @req REL-UPD-05
 * @req REL-UPD-08
 * @why Parrot updates itself in the window: the main process downloads in the background, the renderer shows the
 *   shared update modal (`DesktopUpdatePrompt`) once a version is ready, with Restart now, Remind me later and Ignore,
 *   and Settings › About & updates shows the version, the updater's state, its one Check / Download / Restart button
 *   and the automatic-updates switch. These tests drive both surfaces through the same bridge the preload exposes.
 *   The modal renders through a portal, so its queries search `document`.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdaterBridge, UpdaterCheckResult, UpdaterEvent, UpdaterState } from "@space/desktop-shell/updater";
import { ParrotUpdatePrompt, ParrotUpdateSection } from "../src/renderer/src/updates";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-UPDATES-001]";
const readyPrompt = <ParrotUpdatePrompt language="en" />;

const mainState = (state: Partial<UpdaterState> = {}): UpdaterState => ({
  phase: "idle",
  version: null,
  releaseNotes: null,
  progress: 0,
  errorMessage: null,
  mandatory: false,
  autoUpdate: true,
  currentVersion: null,
  lastCheckedAt: null,
  channel: "self",
  canInstall: false,
  manualCommand: null,
  failure: null,
  failureDetail: null,
  remindLater: null,
  ignoredVersion: null,
  ...state,
});

type FakeBridge = UpdaterBridge & { emit: (event: UpdaterEvent) => void; listeners: Set<(event: UpdaterEvent) => void> };

const makeBridge = (initial: UpdaterState, checkResult: UpdaterCheckResult = { status: "up-to-date" }): FakeBridge => {
  const listeners = new Set<(event: UpdaterEvent) => void>();
  return {
    listeners,
    emit: (event) => listeners.forEach((listener) => listener(event)),
    check: vi.fn(async () => checkResult),
    downloadUpdate: vi.fn(async () => ({ ok: true })),
    installAndRestart: vi.fn(async () => ({ ok: true })),
    setAutoUpdate: vi.fn(async (_enabled: boolean) => ({ ok: true })),
    remindLater: vi.fn(async () => ({ ok: true })),
    ignoreVersion: vi.fn(async () => ({ ok: true })),
    getState: vi.fn(async () => initial),
    onEvent: vi.fn((listener: (event: UpdaterEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

const mount = async (element: React.ReactElement) => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(element));
  await flush();
};

const q = <T extends Element = HTMLElement>(testId: string) => document.querySelector<T>(`[data-testid="${testId}"]`);

const dump = (testId: string, bridge?: FakeBridge) =>
  console.info(
    `${SUITE}[${testId}] html=${document.body.innerHTML || "(none)"} ` +
      (bridge
        ? `check=${(bridge.check as ReturnType<typeof vi.fn>).mock.calls.length} ` +
          `download=${(bridge.downloadUpdate as ReturnType<typeof vi.fn>).mock.calls.length} ` +
          `install=${(bridge.installAndRestart as ReturnType<typeof vi.fn>).mock.calls.length} ` +
          `setAuto=${JSON.stringify((bridge.setAutoUpdate as ReturnType<typeof vi.fn>).mock.calls)} ` +
          `remindLater=${(bridge.remindLater as ReturnType<typeof vi.fn>).mock.calls.length} ` +
          `ignore=${(bridge.ignoreVersion as ReturnType<typeof vi.fn>).mock.calls.length}`
        : ""),
  );

const install = (bridge: FakeBridge | undefined) => {
  if (bridge) Object.assign(window, { parrot: { updater: bridge } });
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  Reflect.deleteProperty(window, "parrot");
});

describe("ParrotUpdatePrompt", () => {
  // @req REL-UPD-08
  it("opens once the main process reports a downloaded version, and Restart now installs", async () => {
    const testId = "ready-from-main-state";
    const bridge = makeBridge(mainState({ phase: "downloaded", version: "2.1.0", progress: 100 }));
    install(bridge);
    console.info(`${SUITE}[${testId}] phase:mount with main state downloaded 2.1.0`);
    await mount(readyPrompt);
    dump(testId, bridge);
    const prompt = q("update-prompt");
    expect(prompt).not.toBeNull();
    expect(prompt!.getAttribute("role")).toBe("dialog");
    expect(prompt!.getAttribute("data-view")).toBe("ready");
    expect(prompt!.textContent).toContain("Update ready");
    expect(q("update-prompt-message")!.textContent).toBe("Parrot 2.1.0 has downloaded. It installs the next time you quit Parrot.");
    console.info(`${SUITE}[${testId}] phase:click restart`);
    await act(async () => q<HTMLButtonElement>("update-prompt-install")!.click());
    dump(testId, bridge);
    expect(bridge.installAndRestart).toHaveBeenCalledTimes(1);
  });

  // @req REL-UPD-08
  it("stays hidden until a background download finishes, then opens; Remind me later asks main and hides it", async () => {
    const testId = "ready-from-event";
    const bridge = makeBridge(mainState());
    install(bridge);
    await mount(readyPrompt);
    dump(testId, bridge);
    expect(q("update-prompt")).toBeNull();
    console.info(`${SUITE}[${testId}] phase:emit update-available + progress`);
    await act(async () => {
      bridge.emit({ kind: "update-available", version: "2.2.0", releaseNotes: null });
      bridge.emit({ kind: "download-progress", percent: 40 });
    });
    dump(testId, bridge);
    expect(q("update-prompt")).toBeNull();
    console.info(`${SUITE}[${testId}] phase:emit update-downloaded`);
    await act(async () => bridge.emit({ kind: "update-downloaded", version: "2.2.0" }));
    dump(testId, bridge);
    expect(q("update-prompt")).not.toBeNull();
    console.info(`${SUITE}[${testId}] phase:click remind me later, main answers prompt-snoozed`);
    await act(async () => q<HTMLButtonElement>("update-prompt-later")!.click());
    await act(async () => bridge.emit({ kind: "prompt-snoozed", version: "2.2.0", until: Date.now() + 24 * 3600 * 1000 }));
    dump(testId, bridge);
    expect(bridge.remindLater).toHaveBeenCalledTimes(1);
    expect(q("update-prompt")).toBeNull();
    expect(bridge.installAndRestart).not.toHaveBeenCalled();
  });

  // @req REL-UPD-08
  it("Ignore asks main to skip the version; a newer version opens the modal again", async () => {
    const testId = "ready-ignore";
    const bridge = makeBridge(mainState({ phase: "downloaded", version: "2.2.0", progress: 100 }));
    install(bridge);
    await mount(readyPrompt);
    console.info(`${SUITE}[${testId}] phase:click ignore, main answers prompt-ignored`);
    await act(async () => q<HTMLButtonElement>("update-prompt-ignore")!.click());
    await act(async () => bridge.emit({ kind: "prompt-ignored", version: "2.2.0" }));
    dump(testId, bridge);
    expect(bridge.ignoreVersion).toHaveBeenCalledTimes(1);
    expect(q("update-prompt")).toBeNull();
    console.info(`${SUITE}[${testId}] phase:emit newer version downloaded`);
    await act(async () => bridge.emit({ kind: "update-downloaded", version: "2.3.0" }));
    dump(testId, bridge);
    expect(q("update-prompt-message")!.textContent).toContain("Parrot 2.3.0 has downloaded.");
  });

  // @req REL-UPD-08
  it("a downloaded update without a version still reads as a sentence, not an empty name", async () => {
    const testId = "ready-no-version";
    const bridge = makeBridge(mainState({ phase: "downloaded", version: null, progress: 100 }));
    install(bridge);
    await mount(readyPrompt);
    dump(testId, bridge);
    const message = q("update-prompt-message");
    expect(message).not.toBeNull();
    expect(message!.textContent).toBe("A new version of Parrot has downloaded. It installs the next time you quit Parrot.");
    expect(message!.textContent).not.toContain("Parrot  has");
  });

  // @req REL-UPD-08
  it("stays out of the way of a mandatory update (the blocking screen handles it)", async () => {
    const testId = "ready-mandatory";
    const bridge = makeBridge(mainState({ phase: "downloaded", version: "3.0.0", progress: 100, mandatory: true }));
    install(bridge);
    await mount(readyPrompt);
    dump(testId, bridge);
    expect(q("update-prompt")).toBeNull();
  });

  // @req REL-UPD-08
  it("renders nothing without a bridge (browser build)", async () => {
    const testId = "ready-no-bridge";
    await mount(readyPrompt);
    dump(testId);
    expect(q("update-prompt")).toBeNull();
    expect(container!.innerHTML).toBe("");
  });
});

const status = () => q("update-section-status")!;
const action = () => q<HTMLButtonElement>("update-section-action");

describe("Parrot Settings › About & updates", () => {
  // @req REL-UPD-02
  it("shows the automatic-updates switch from main's state and saves a change through the bridge", async () => {
    const testId = "settings-auto-switch";
    const bridge = makeBridge(mainState({ autoUpdate: true }));
    install(bridge);
    await mount(<ParrotUpdateSection language="en" />);
    const toggle = () => q<HTMLButtonElement>("settings-auto-update-switch");
    dump(testId, bridge);
    expect(toggle()!.getAttribute("aria-checked")).toBe("true");
    console.info(`${SUITE}[${testId}] phase:turn off`);
    await act(async () => toggle()!.click());
    await flush();
    dump(testId, bridge);
    expect(bridge.setAutoUpdate).toHaveBeenCalledWith(false);
    expect(toggle()!.getAttribute("aria-checked")).toBe("false");
  });

  // @req REL-UPD-02
  it("shows main's stored OFF answer", async () => {
    const testId = "settings-auto-off";
    const bridge = makeBridge(mainState({ autoUpdate: false }));
    install(bridge);
    await mount(<ParrotUpdateSection language="en" />);
    dump(testId, bridge);
    expect(q("settings-auto-update-switch")!.getAttribute("aria-checked")).toBe("false");
  });

  // @req REL-UPD-05
  it("shows the installed version main reports, in the window's language", async () => {
    const testId = "settings-version";
    const bridge = makeBridge(mainState({ currentVersion: "0.1.5" }));
    install(bridge);
    await mount(<ParrotUpdateSection language="fr" />);
    dump(testId, bridge);
    expect(q("update-section-version")!.textContent).toBe("Version 0.1.5");
    expect(action()!.textContent).toBe("Rechercher des mises à jour");
  });

  // @req REL-UPD-05
  it("Check for updates says up to date, with the time, when there is nothing new", async () => {
    const testId = "settings-check-up-to-date";
    const bridge = makeBridge(mainState(), { status: "up-to-date" });
    install(bridge);
    await mount(<ParrotUpdateSection language="en" />);
    console.info(`${SUITE}[${testId}] phase:click check`);
    await act(async () => action()!.click());
    await act(async () => bridge.emit({ kind: "update-not-available", checkedAt: Date.now() }));
    await flush();
    dump(testId, bridge);
    expect(bridge.check).toHaveBeenCalledTimes(1);
    expect(bridge.downloadUpdate).not.toHaveBeenCalled();
    expect(status().getAttribute("data-phase")).toBe("idle");
    expect(status().getAttribute("data-checked")).toBe("1");
    expect(status().textContent).toContain("Parrot is up to date · checked");
  });

  // @req REL-UPD-05
  it("with automatic updates on, a found update downloads right away and the button turns into Restart", async () => {
    const testId = "settings-check-auto-downloads";
    const bridge = makeBridge(mainState({ autoUpdate: true }), { status: "available", version: "2.3.0" });
    install(bridge);
    await mount(<ParrotUpdateSection language="en" />);
    console.info(`${SUITE}[${testId}] phase:click check`);
    await act(async () => action()!.click());
    await flush();
    dump(testId, bridge);
    expect(bridge.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(status().getAttribute("data-phase")).toBe("downloading");
    await act(async () => bridge.emit({ kind: "download-progress", percent: 40 }));
    dump(testId, bridge);
    expect(q("update-section-progress")!.getAttribute("aria-valuenow")).toBe("40");
    console.info(`${SUITE}[${testId}] phase:emit update-downloaded`);
    await act(async () => bridge.emit({ kind: "update-downloaded", version: "2.3.0" }));
    dump(testId, bridge);
    expect(status().textContent).toContain("Version 2.3.0 is ready to install");
    expect(action()!.getAttribute("data-action")).toBe("restart");
    await act(async () => action()!.click());
    expect(bridge.installAndRestart).toHaveBeenCalledTimes(1);
  });

  // @req REL-UPD-05
  it("with automatic updates off, a found update waits for Download update", async () => {
    const testId = "settings-check-manual-download";
    const bridge = makeBridge(mainState({ autoUpdate: false }), { status: "available", version: "2.3.0" });
    install(bridge);
    await mount(<ParrotUpdateSection language="en" />);
    console.info(`${SUITE}[${testId}] phase:click check`);
    await act(async () => action()!.click());
    await flush();
    dump(testId, bridge);
    expect(bridge.downloadUpdate).not.toHaveBeenCalled();
    expect(status().textContent).toContain("Version 2.3.0 is available.");
    expect(action()!.getAttribute("data-action")).toBe("download");
    console.info(`${SUITE}[${testId}] phase:click download`);
    await act(async () => action()!.click());
    await flush();
    dump(testId, bridge);
    expect(bridge.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  // @req REL-UPD-05
  it("a failed check says so and offers to check again", async () => {
    const testId = "settings-check-failed";
    const bridge = makeBridge(mainState(), { status: "error", message: "net::ERR_INTERNET_DISCONNECTED" });
    install(bridge);
    await mount(<ParrotUpdateSection language="en" />);
    await act(async () => action()!.click());
    await flush();
    dump(testId, bridge);
    expect(status().getAttribute("data-phase")).toBe("error");
    expect(status().textContent).toContain("Couldn't reach the update server. Try again later.");
    expect(status().textContent).not.toContain("ERR_INTERNET");
    expect(action()!.getAttribute("data-action")).toBe("check");
  });

  // @req REL-UPD-05
  it("without a bridge or when main reports the build unsupported: no button, no switch, just the explanation", async () => {
    const testId = "settings-unsupported";
    await mount(<ParrotUpdateSection language="en" />);
    dump(testId);
    expect(action()).toBeNull();
    expect(q("settings-auto-update-switch")).toBeNull();
    expect(status().getAttribute("data-phase")).toBe("unsupported");
    act(() => root?.unmount());
    container?.remove();
    const bridge = makeBridge(mainState({ phase: "unsupported" }));
    install(bridge);
    await mount(<ParrotUpdateSection language="en" />);
    dump(testId, bridge);
    expect(action()).toBeNull();
    expect(status().getAttribute("data-phase")).toBe("unsupported");
  });
});
