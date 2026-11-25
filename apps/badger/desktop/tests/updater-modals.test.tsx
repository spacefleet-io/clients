// @vitest-environment jsdom

/**
 * Smoke tests for the Part D3/E4 modals: LibraryFormatTooNewModal,
 * UpdateAvailableModal and the server-mandatory update gates. (Settings' manual check lives in the shared
 * About & updates section, tested in packages/desktop-shell/tests/update-section.test.tsx.)
 *
 * We verify render behavior (open/closed, CTA wiring) without hitting real
 * Radix primitives. The @space/ui mock provides plain HTML elements so the
 * tests stay deterministic and fast.
 */

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import type { UpdaterState } from "@/lib/useUpdater";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Shared mocks required by all three components
// ---------------------------------------------------------------------------

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, params?: Record<string, unknown>) => {
    if (params && Object.keys(params).length > 0) {
      return `${key}(${JSON.stringify(params)})`;
    }
    return key;
  }, i18n: { language: "en" } }),
}));

vi.mock("@space/ui", () => ({
  Button: ({ children, onClick, disabled, pending, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { pending?: boolean }) =>
    React.createElement("button", { onClick, disabled: disabled || pending, ...rest }, children),
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) =>
    open ? React.createElement("div", { "data-testid": "dialog" }, children) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "dialog-content" }, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement("h2", null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement("p", null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  Switch: ({ checked, onCheckedChange, ...rest }: { checked: boolean; onCheckedChange: (next: boolean) => void }) =>
    React.createElement("button", { role: "switch", "aria-checked": checked, onClick: () => onCheckedChange(!checked), ...rest }),
}));

vi.mock("lucide-react", () => ({
  AlertTriangle: () => React.createElement("span", { "aria-hidden": "true" }, "[!]"),
  ArrowUpCircle: () => React.createElement("span", { "aria-hidden": "true" }, "[↑]"),
  CheckCircle2: () => React.createElement("span", { "aria-hidden": "true" }, "[✓]"),
  Download: () => React.createElement("span", { "aria-hidden": "true" }, "[↓]"),
  Loader2: () => React.createElement("span", { "aria-hidden": "true" }, "[…]"),
  RefreshCw: () => React.createElement("span", { "aria-hidden": "true" }, "[↺]"),
  RotateCw: () => React.createElement("span", { "aria-hidden": "true" }, "[⟳]"),
}));

// The app-level gates read useUpdater — mock it at the module boundary.
const mockUseUpdater = vi.hoisted(() => vi.fn());
vi.mock("@/lib/useUpdater", () => ({
  useUpdater: mockUseUpdater,
}));
// The app-level gate's automatic-updates switch reads the window's settings.
vi.mock("@/lib/settings/useClientSettings", () => ({
  useClientSettings: () => ({ config: { autoUpdate: true }, updateSetting: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  if (container?.parentNode) {
    container.parentNode.removeChild(container);
  }
  container = null;
  root = null;
});

const render = (element: React.ReactElement) => {
  act(() => {
    root!.render(element);
  });
};

// On assertion failure, dump enough rendered-DOM state to diagnose offline
// (per memory feedback: tests must self-diagnose; never recommend manual
// repro). These modal tests assert on dialog presence, button text/disabled
// state, and progressbar attributes — so the dumper enumerates exactly that.
// Body is try/catch-wrapped so a snapshot failure never masks the assertion.
const dumpUpdaterModalsSnapshot = (label: string) => {
  try {
    const dialog = container?.querySelector("[data-testid='dialog']") ?? null;
    const buttons = container
      ? Array.from(container.querySelectorAll("button")).map((b) => ({
          text: (b.textContent ?? "").trim().slice(0, 60),
          disabled: b.disabled,
        }))
      : [];
    const progressBar = container?.querySelector("[role='progressbar']") ?? null;
    console.error(`=== [updater-modals:${label}] snapshot ===`);
    console.error(`dialog present=${dialog !== null}`);
    console.error(`buttons (${buttons.length}):\n${JSON.stringify(buttons, null, 2)}`);
    console.error(
      `progressbar present=${progressBar !== null} aria-valuenow=${JSON.stringify(progressBar?.getAttribute("aria-valuenow") ?? null)}`,
    );
    console.error(`container.innerHTML=${JSON.stringify((container?.innerHTML ?? "").slice(0, 400))}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// ---------------------------------------------------------------------------
// LibraryFormatTooNewModal
// ---------------------------------------------------------------------------

describe("LibraryFormatTooNewModal (Part D3)", async () => {
  const { default: LibraryFormatTooNewModal } = await import(
    "../src/renderer/src/components/LibraryFormatTooNewModal"
  );

  it("does not render when detail is null (closed)", () => {
    console.info(`[updater-modals:format-too-new] render with detail=null; expect closed (no dialog)`);
    render(
      React.createElement(LibraryFormatTooNewModal, {
        detail: null,
        onUpdateNow: vi.fn(),
      })
    );
    const dialog = container!.querySelector("[data-testid='dialog']");
    if (dialog !== null) dumpUpdaterModalsSnapshot("format-too-new-closed-unexpected-dialog");
    expect(dialog).toBeNull();
  });

  it("renders the dialog when detail is non-null (open)", () => {
    console.info(`[updater-modals:format-too-new] render with non-null detail (surface=storage observed=2 supported=1)`);
    render(
      React.createElement(LibraryFormatTooNewModal, {
        detail: { surface: "storage", observed: 2, supported: 1 },
        onUpdateNow: vi.fn(),
      })
    );
    const dialog = container!.querySelector("[data-testid='dialog']");
    if (dialog === null) dumpUpdaterModalsSnapshot("format-too-new-open-missing-dialog");
    expect(dialog).not.toBeNull();
  });

  it("calls onUpdateNow when the Update Now button is clicked", async () => {
    console.info(`[updater-modals:format-too-new] render with detail (surface=op-stream), click Update Now`);
    const onUpdateNow = vi.fn();
    render(
      React.createElement(LibraryFormatTooNewModal, {
        detail: { surface: "op-stream", observed: 3, supported: 1 },
        onUpdateNow,
      })
    );
    const btn = container!.querySelector("button");
    if (btn === null) dumpUpdaterModalsSnapshot("format-too-new-update-missing-button");
    expect(btn).not.toBeNull();
    await act(async () => {
      btn!.click();
    });
    console.info(`[updater-modals:format-too-new] clicked; onUpdateNow.calls=${onUpdateNow.mock.calls.length}`);
    if (onUpdateNow.mock.calls.length !== 1) dumpUpdaterModalsSnapshot("format-too-new-update-not-fired");
    expect(onUpdateNow).toHaveBeenCalledTimes(1);
  });

  it("disables the Update Now button while updating=true", () => {
    console.info(`[updater-modals:format-too-new] render with updating=true; expect Update Now disabled`);
    render(
      React.createElement(LibraryFormatTooNewModal, {
        detail: { surface: "storage", observed: 2, supported: 1 },
        onUpdateNow: vi.fn(),
        updating: true,
      })
    );
    const btn = container!.querySelector("button");
    console.info(`[updater-modals:format-too-new] button.disabled=${btn?.disabled}`);
    if (btn?.disabled !== true) dumpUpdaterModalsSnapshot("format-too-new-updating-not-disabled");
    expect(btn?.disabled).toBe(true);
  });

  it("@req REL-UPD-01 shows Update Now only — no download notice, on every OS", () => {
    render(
      React.createElement(LibraryFormatTooNewModal, {
        detail: { surface: "storage", observed: 2, supported: 1 },
        onUpdateNow: vi.fn(),
      })
    );
    const buttons = Array.from(container!.querySelectorAll("button")).map((b) => b.textContent);
    const text = container!.textContent ?? "";
    console.info(`[updater-modals:format-too-new-update-now-only] text=${JSON.stringify(text)} buttons=${JSON.stringify(buttons)}`);
    if (buttons.length !== 1) dumpUpdaterModalsSnapshot("format-too-new-update-now-only");
    expect(buttons).toEqual(["libraryFormat.tooNew.updateNow"]);
    expect(text).not.toContain("downloadNotice");
  });
});

// ---------------------------------------------------------------------------
// UpdateAvailableModal
// ---------------------------------------------------------------------------

describe("UpdateAvailableModal (Part E4)", async () => {
  const { default: UpdateAvailableModal } = await import(
    "../src/renderer/src/components/UpdateAvailableModal"
  );

  const baseState: UpdaterState = {
    phase: "available",
    version: "2.1.0",
    releaseNotes: null,
    progress: 0,
    errorMessage: null,
    mandatory: false,
    autoUpdate: true,
    currentVersion: "2.0.0",
    lastCheckedAt: null,
    channel: "self",
    canInstall: false,
    manualCommand: null,
    failure: null,
    failureDetail: null,
  };

  it("does not render when open=false", () => {
    console.info(`[updater-modals:update-available] render open=false; expect no dialog`);
    render(
      React.createElement(UpdateAvailableModal, {
        open: false,
        state: baseState,
        onDownload: vi.fn(),
        onRestart: vi.fn(),
      })
    );
    const dialog = container!.querySelector("[data-testid='dialog']");
    if (dialog !== null) dumpUpdaterModalsSnapshot("update-available-closed-unexpected-dialog");
    expect(dialog).toBeNull();
  });

  it("renders dialog when open=true", () => {
    console.info(`[updater-modals:update-available] render open=true phase=available; expect dialog`);
    render(
      React.createElement(UpdateAvailableModal, {
        open: true,
        state: baseState,
        onDownload: vi.fn(),
        onRestart: vi.fn(),
      })
    );
    const dialog = container!.querySelector("[data-testid='dialog']");
    if (dialog === null) dumpUpdaterModalsSnapshot("update-available-open-missing-dialog");
    expect(dialog).not.toBeNull();
  });

  it("calls onDownload when the download button is clicked", async () => {
    console.info(`[updater-modals:update-available] render phase=available, find+click download button`);
    const onDownload = vi.fn();
    render(
      React.createElement(UpdateAvailableModal, {
        open: true,
        state: baseState,
        onDownload,
        onRestart: vi.fn(),
      })
    );
    // The primary action button is the last or only button in the footer.
    const buttons = Array.from(container!.querySelectorAll("button"));
    // With no onDismiss, only the download button appears.
    const downloadBtn = buttons.find((b) => b.textContent?.includes("updater.available.download"));
    console.info(`[updater-modals:update-available] buttons=${buttons.length} downloadBtn found=${downloadBtn !== undefined}`);
    if (downloadBtn === undefined) dumpUpdaterModalsSnapshot("update-available-download-button-missing");
    expect(downloadBtn).not.toBeUndefined();
    await act(async () => {
      downloadBtn!.click();
    });
    console.info(`[updater-modals:update-available] clicked download; onDownload.calls=${onDownload.mock.calls.length}`);
    if (onDownload.mock.calls.length !== 1) dumpUpdaterModalsSnapshot("update-available-download-not-fired");
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("shows Restart button and calls onRestart when phase=downloaded", async () => {
    console.info(`[updater-modals:update-available] render phase=downloaded progress=100, find+click restart button`);
    const onRestart = vi.fn();
    render(
      React.createElement(UpdateAvailableModal, {
        open: true,
        state: { ...baseState, phase: "downloaded", progress: 100 },
        onDownload: vi.fn(),
        onRestart,
      })
    );
    const buttons = Array.from(container!.querySelectorAll("button"));
    const restartBtn = buttons.find((b) => b.textContent?.includes("updater.available.restart"));
    console.info(`[updater-modals:update-available] buttons=${buttons.length} restartBtn found=${restartBtn !== undefined}`);
    if (restartBtn === undefined) dumpUpdaterModalsSnapshot("update-available-restart-button-missing");
    expect(restartBtn).not.toBeUndefined();
    await act(async () => {
      restartBtn!.click();
    });
    console.info(`[updater-modals:update-available] clicked restart; onRestart.calls=${onRestart.mock.calls.length}`);
    if (onRestart.mock.calls.length !== 1) dumpUpdaterModalsSnapshot("update-available-restart-not-fired");
    expect(onRestart).toHaveBeenCalledTimes(1);
  });

  it("shows a progress bar while downloading", () => {
    console.info(`[updater-modals:update-available] render phase=downloading progress=55; expect progressbar @55`);
    render(
      React.createElement(UpdateAvailableModal, {
        open: true,
        state: { ...baseState, phase: "downloading", progress: 55 },
        onDownload: vi.fn(),
        onRestart: vi.fn(),
      })
    );
    const progressBar = container!.querySelector("[role='progressbar']");
    const valueNow = progressBar?.getAttribute("aria-valuenow");
    console.info(`[updater-modals:update-available] progressbar present=${progressBar !== null} aria-valuenow=${JSON.stringify(valueNow)}`);
    if (progressBar === null || valueNow !== "55") dumpUpdaterModalsSnapshot("update-available-progressbar-mismatch");
    expect(progressBar).not.toBeNull();
    expect(progressBar?.getAttribute("aria-valuenow")).toBe("55");
  });

  it("@req REL-UPD-01 an optional update offers Later and Download; Download calls onDownload", async () => {
    const onDownload = vi.fn();
    const onDismiss = vi.fn();
    render(
      React.createElement(UpdateAvailableModal, {
        open: true,
        state: { ...baseState, version: "1.4.0" },
        onDownload,
        onRestart: vi.fn(),
        onDismiss,
      })
    );
    const text = container!.textContent ?? "";
    const buttons = Array.from(container!.querySelectorAll("button"));
    console.info(`[updater-modals:optional] text=${JSON.stringify(text)} buttons=${JSON.stringify(buttons.map((b) => b.textContent))}`);
    try {
      expect(text).toContain("updater.available.title");
      expect(text).toContain('updater.available.body({"version":"1.4.0"})');
      expect(buttons.map((b) => b.textContent)).toEqual(["updater.available.later", "updater.available.download"]);
      await act(async () => {
        buttons[1]!.click();
      });
      expect(onDownload).toHaveBeenCalledTimes(1);
      await act(async () => {
        buttons[0]!.click();
      });
      expect(onDismiss).toHaveBeenCalledTimes(1);
    } catch (err) {
      dumpUpdaterModalsSnapshot("optional");
      throw err;
    }
  });

  it("@req REL-UPD-01 a mandatory update stays blocking (no Later) with only Download", () => {
    render(
      React.createElement(UpdateAvailableModal, {
        open: true,
        state: { ...baseState, version: null, mandatory: true },
        onDownload: vi.fn(),
        onRestart: vi.fn(),
      })
    );
    const buttons = Array.from(container!.querySelectorAll("button")).map((b) => b.textContent);
    console.info(`[updater-modals:mandatory-blocking] buttons=${JSON.stringify(buttons)}`);
    if (buttons.length !== 1) dumpUpdaterModalsSnapshot("mandatory-blocking");
    expect(buttons).toEqual(["updater.available.download"]);
    expect(container!.textContent).toContain("updater.available.bodyCurrent");
  });
});

// ---------------------------------------------------------------------------
// Server-mandatory update (release-status, Part E1/E4): AppUpdateRequiredGate above the routes carries it on every
// screen (REL-CD-29); LibraryUpdateGate stays closed so two prompts never stack.
// ---------------------------------------------------------------------------

vi.mock("@/lib/libraryContext", () => ({
  useLibraryShell: () => ({ formatTooNew: null }),
}));

describe("server-mandatory update (Part E1/E4) — app-level gate, library gate stays closed", async () => {
  const { default: LibraryUpdateGate } = await import(
    "../src/renderer/src/components/LibraryUpdateGate"
  );
  const { default: AppUpdateRequiredGate } = await import(
    "../src/renderer/src/components/AppUpdateRequiredGate"
  );

  const baseUpdaterReturn = {
    state: {
      phase: "idle" as const,
      version: null,
      releaseNotes: null,
      progress: 0,
      errorMessage: null,
      mandatory: false,
      autoUpdate: true,
    },
    supported: true,
    check: vi.fn(async () => "idle" as const),
    download: vi.fn(async () => {}),
    install: vi.fn(),
    runFullUpdate: vi.fn(async () => {}),
    reset: vi.fn(),
  };

  beforeEach(() => {
    // Stub setAutoUpdate so the one-shot useEffect does not throw.
    vi.stubGlobal("spaceBadger", {
      updater: { setAutoUpdate: vi.fn(async () => {}) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not render UpdateAvailableModal when mandatory is false", () => {
    console.info(`[updater-modals:update-gate] render mandatory=false; expect no dialog`);
    mockUseUpdater.mockReturnValue({ ...baseUpdaterReturn });
    render(React.createElement(LibraryUpdateGate));
    const dialog = container!.querySelector("[data-testid='dialog']");
    if (dialog !== null) dumpUpdaterModalsSnapshot("update-gate-nonmandatory-unexpected-dialog");
    expect(dialog).toBeNull();
  });

  it("@req REL-CD-29 the app-level gate shows the shared update-required screen for a release-status mandatory update", () => {
    console.info(`[updater-modals:update-gate] render app gate mandatory=true phase=available; expect the update-required screen`);
    const check = vi.fn(async () => "available" as const);
    mockUseUpdater.mockReturnValue({
      ...baseUpdaterReturn,
      state: { ...baseUpdaterReturn.state, mandatory: true, phase: "available" as const },
      check,
    });
    render(React.createElement(AppUpdateRequiredGate, { refusal: null }));
    const screen = container!.querySelector("[data-testid='update-required']");
    if (screen === null) dumpUpdaterModalsSnapshot("update-gate-mandatory-missing-screen");
    expect(screen).not.toBeNull();
    // The release-status answer came from a check main already ran: no second check.
    console.info(`[updater-modals:update-gate] check.calls=${check.mock.calls.length}`);
    expect(check).not.toHaveBeenCalled();
  });

  it("the library gate stays closed for a release-status mandatory update (the app-level gate carries it)", () => {
    console.info(`[updater-modals:update-gate] render library gate mandatory=true; expect no dialog`);
    mockUseUpdater.mockReturnValue({
      ...baseUpdaterReturn,
      state: { ...baseUpdaterReturn.state, mandatory: true, phase: "available" as const },
    });
    render(React.createElement(LibraryUpdateGate));
    const dialog = container!.querySelector("[data-testid='dialog']");
    if (dialog !== null) dumpUpdaterModalsSnapshot("update-gate-library-gate-stacked");
    expect(dialog).toBeNull();
  });

  it("the update-required screen has no way out: only the update button and the automatic-updates switch", () => {
    mockUseUpdater.mockReturnValue({
      ...baseUpdaterReturn,
      state: { ...baseUpdaterReturn.state, mandatory: true, phase: "available" as const, version: "2.0.0" },
    });
    render(React.createElement(AppUpdateRequiredGate, { refusal: null }));
    const controls = Array.from(container!.querySelectorAll("[data-testid='update-required'] button")).map((b) => b.getAttribute("data-testid"));
    console.info(`[updater-modals:update-gate] controls=${JSON.stringify(controls)}`);
    if (controls.length !== 2) dumpUpdaterModalsSnapshot("update-gate-controls");
    expect(controls).toEqual(["update-section-action", "settings-auto-update-switch"]);
  });

  it("@req REL-UPD-01 a mandatory update that finished downloading blocks with Restart only, which installs", async () => {
    const install = vi.fn();
    mockUseUpdater.mockReturnValue({
      ...baseUpdaterReturn,
      state: { ...baseUpdaterReturn.state, mandatory: true, phase: "downloaded" as const, version: "1.4.0", progress: 100 },
      install,
    });
    render(React.createElement(AppUpdateRequiredGate, { refusal: null }));
    const action = container!.querySelector<HTMLButtonElement>("[data-testid='update-required'] [data-testid='update-section-action']");
    console.info(`[updater-modals:update-gate-downloaded] action=${action?.getAttribute("data-action")} label=${action?.textContent}`);
    if (action?.getAttribute("data-action") !== "restart") dumpUpdaterModalsSnapshot("update-gate-downloaded");
    expect(action?.getAttribute("data-action")).toBe("restart");
    expect(action?.textContent).toContain("Restart to update");
    await act(async () => {
      action!.click();
    });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("@req REL-UPD-01 the gate no longer pushes the auto-update setting (usePushStoredAutoUpdate does)", () => {
    const setAutoUpdate = vi.fn(async () => undefined);
    vi.stubGlobal("spaceBadger", { updater: { setAutoUpdate } });
    mockUseUpdater.mockReturnValue({ ...baseUpdaterReturn });
    render(React.createElement(LibraryUpdateGate));
    console.info(`[updater-modals:update-gate-no-push] setAutoUpdate.calls=${setAutoUpdate.mock.calls.length}`);
    expect(setAutoUpdate).not.toHaveBeenCalled();
  });
});
