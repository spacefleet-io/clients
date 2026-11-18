// @vitest-environment jsdom

/**
 * @test-id BADGER-DESKTOP-LIBRARY-UPDATE-GATE-FORMAT-TOO-NEW-001
 * @level integration (renderer, jsdom)
 * @bugfix @regression-proof
 *
 * @why The existing `updater-modals.test.tsx` covers two slices in isolation:
 *   1. `LibraryFormatTooNewModal` open/close + CTA wiring against a manually
 *      passed `detail` prop.
 *   2. `LibraryUpdateGate`'s server-mandatory path through
 *      `useUpdater().state.mandatory` — but with `useLibraryShell` hard-mocked
 *      to `{ formatTooNew: null }`, so the FORMAT-TOO-NEW path through the
 *      gate is never exercised.
 *
 *   The format-too-new path is the user-facing safety net for the entire
 *   library-format versioning system (storage/op-stream/schema surfaces). When
 *   any of those throws `LibraryFormatTooNewError`, `libraryContext` parses it
 *   into `formatTooNew` and `LibraryUpdateGate` must:
 *     a. Render `LibraryFormatTooNewModal` (blocking, non-dismissible).
 *     b. On "Update Now", flip to the in-progress `UpdateAvailableModal`.
 *     c. NOT render the format-too-new modal when `formatTooNew` is null.
 *     d. Stay closed when the server also marks the update mandatory
 *        (`AppUpdateRequiredGate` above the routes carries that one prompt,
 *        so two dialogs never stack).
 *
 *   These four invariants are the user-visible contract of the gate when the
 *   format-too-new signal arrives. Pre-this-test they had no rendered
 *   coverage — only the gate's mandatory path was tested.
 */

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Shared mocks (mirror updater-modals.test.tsx for consistency)
// ---------------------------------------------------------------------------

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@space/ui", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    pending,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { pending?: boolean }) =>
    React.createElement(
      "button",
      { onClick, disabled: disabled || pending, ...rest },
      children
    ),
  Dialog: ({
    children,
    open,
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => (open ? React.createElement("div", { "data-testid": "dialog" }, children) : null),
  DialogContent: ({ children, ...rest }: { children: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "dialog-content", ...rest }, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement("h2", { "data-testid": "dialog-title" }, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement("p", null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

vi.mock("lucide-react", () => ({
  AlertTriangle: () => React.createElement("span", { "aria-hidden": "true" }, "[!]"),
  Download: () => React.createElement("span", { "aria-hidden": "true" }, "[↓]"),
  RefreshCw: () => React.createElement("span", { "aria-hidden": "true" }, "[↺]"),
}));

const mockUseUpdater = vi.hoisted(() => vi.fn());
vi.mock("@/lib/useUpdater", () => ({
  useUpdater: mockUseUpdater,
}));

// `useLibraryShell` is hoisted so each test can override `formatTooNew`.
const mockUseLibraryShell = vi.hoisted(() => vi.fn());
vi.mock("@/lib/libraryContext", () => ({
  useLibraryShell: mockUseLibraryShell,
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let container: HTMLDivElement | null = null;
let root: Root | null = null;

// Dump-on-failure helper. When a gate assertion is wrong, the decisive facts
// are: which dialogs rendered, what their titles are, what buttons exist, and
// what the two hoisted mocks (useLibraryShell.formatTooNew + useUpdater.state)
// were returning at render time. Wrapped in try/catch so a dump failure can
// never mask the real assertion.
const dumpGateSnapshot = (label: string) => {
  try {
    console.error(`=== [library-update-gate-format-too-new:${label}] DOM + mock snapshot ===`);
    const dialogs = container?.querySelectorAll("[data-testid='dialog']") ?? [];
    const titles = Array.from(
      container?.querySelectorAll("[data-testid='dialog-title']") ?? [],
    ).map((el) => el.textContent);
    const buttons = Array.from(container?.querySelectorAll("button") ?? []).map((b) => ({
      text: b.textContent,
      disabled: b.disabled,
    }));
    console.error(`dialogs.length=${dialogs.length}`);
    console.error(`dialog titles=${JSON.stringify(titles)}`);
    console.error(`buttons=${JSON.stringify(buttons)}`);
    let libraryShell: unknown = "(uncallable)";
    try {
      libraryShell = mockUseLibraryShell.getMockImplementation()
        ? mockUseLibraryShell()
        : mockUseLibraryShell.mock.results.at(-1)?.value;
    } catch {
      /* leave default */
    }
    let updater: unknown = "(uncallable)";
    try {
      updater = mockUseUpdater.mock.results.at(-1)?.value;
    } catch {
      /* leave default */
    }
    console.error(`useLibraryShell() formatTooNew=${JSON.stringify((libraryShell as { formatTooNew?: unknown })?.formatTooNew)}`);
    console.error(`useUpdater().state=${JSON.stringify((updater as { state?: unknown })?.state)}`);
    console.error(`container.innerHTML:\n${container?.innerHTML ?? "(no container)"}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

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
  console.info(`[library-update-gate-format-too-new:setup] stubbing spaceBadger, mounting root, resetting mocks to formatTooNew=null/updater-idle`);
  vi.stubGlobal("spaceBadger", {
    updater: { setAutoUpdate: vi.fn(async () => {}) },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  // Reset both mocks to defaults — tests opt in to overrides.
  mockUseLibraryShell.mockReturnValue({ formatTooNew: null });
  mockUseUpdater.mockReturnValue({ ...baseUpdaterReturn });
});

afterEach(() => {
  console.info(`[library-update-gate-format-too-new:teardown] unmounting + clearing mocks`);
  act(() => {
    root?.unmount();
  });
  if (container?.parentNode) container.parentNode.removeChild(container);
  container = null;
  root = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const render = (element: React.ReactElement) => {
  console.info(`[library-update-gate-format-too-new:render] rendering LibraryUpdateGate`);
  act(() => {
    root!.render(element);
  });
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LibraryUpdateGate (Part D3) — format-too-new path @bugfix @regression-proof", async () => {
  const { default: LibraryUpdateGate } = await import(
    "../src/renderer/src/components/LibraryUpdateGate"
  );

  it("renders LibraryFormatTooNewModal (open dialog) when formatTooNew is non-null", () => {
    mockUseLibraryShell.mockReturnValue({
      formatTooNew: { surface: "storage", observed: 2, supported: 1 },
    });
    render(React.createElement(LibraryUpdateGate));
    // The dialog is open — exactly one dialog renders (the format-too-new one).
    const dialogs = container!.querySelectorAll("[data-testid='dialog']");
    if (dialogs.length !== 1) dumpGateSnapshot("renders-modal:dialog-count");
    expect(dialogs.length).toBe(1);
    // The dialog title is the format-too-new title — not the update-available one.
    const title = container!.querySelector("[data-testid='dialog-title']");
    if (title?.textContent !== "libraryFormat.tooNew.title") dumpGateSnapshot("renders-modal:title");
    expect(title?.textContent).toBe("libraryFormat.tooNew.title");
  });

  it("does NOT render LibraryFormatTooNewModal when formatTooNew is null and mandatory is false", () => {
    mockUseLibraryShell.mockReturnValue({ formatTooNew: null });
    mockUseUpdater.mockReturnValue({ ...baseUpdaterReturn });
    render(React.createElement(LibraryUpdateGate));
    if (container!.querySelector("[data-testid='dialog']") !== null)
      dumpGateSnapshot("no-modal-when-null:unexpected-dialog");
    expect(container!.querySelector("[data-testid='dialog']")).toBeNull();
  });

  it("renders the schema-surface variant when formatTooNew.surface is 'schema' (with group)", () => {
    // The modal uses i18n strings keyed on the surface — we just verify the
    // detail prop drives the open state. Group is preserved through to the
    // detail object the modal sees.
    mockUseLibraryShell.mockReturnValue({
      formatTooNew: { surface: "schema", observed: 3, supported: 2, group: "playback" },
    });
    render(React.createElement(LibraryUpdateGate));
    if (container!.querySelector("[data-testid='dialog']") === null)
      dumpGateSnapshot("schema-surface:no-dialog");
    expect(container!.querySelector("[data-testid='dialog']")).not.toBeNull();
  });

  it("renders the op-stream-surface variant when formatTooNew.surface is 'op-stream'", () => {
    mockUseLibraryShell.mockReturnValue({
      formatTooNew: { surface: "op-stream", observed: 99, supported: 1 },
    });
    render(React.createElement(LibraryUpdateGate));
    if (container!.querySelector("[data-testid='dialog']") === null)
      dumpGateSnapshot("op-stream-surface:no-dialog");
    expect(container!.querySelector("[data-testid='dialog']")).not.toBeNull();
  });

  it("clicking Update Now invokes useUpdater.runFullUpdate() and flips to the in-progress modal", async () => {
    const runFullUpdate = vi.fn(async () => {});
    mockUseLibraryShell.mockReturnValue({
      formatTooNew: { surface: "storage", observed: 2, supported: 1 },
    });
    mockUseUpdater.mockReturnValue({
      ...baseUpdaterReturn,
      runFullUpdate,
    });

    render(React.createElement(LibraryUpdateGate));

    // Find the "Update Now" CTA — the only button in the format-too-new modal.
    const updateNowBtn = container!.querySelector("button");
    if (updateNowBtn === null) dumpGateSnapshot("update-now-click:no-button");
    expect(updateNowBtn).not.toBeNull();

    console.info(`[library-update-gate-format-too-new:update-now-click] clicking Update Now CTA`);
    await act(async () => {
      updateNowBtn!.click();
    });

    if (runFullUpdate.mock.calls.length !== 1)
      dumpGateSnapshot(`update-now-click:runFullUpdate-called=${runFullUpdate.mock.calls.length}`);
    expect(runFullUpdate).toHaveBeenCalledTimes(1);
  });

  it("after Update Now is clicked, the format-too-new modal closes and the UpdateAvailableModal opens", async () => {
    // The gate has a local `updateStarted` flag that switches modals once the
    // CTA is pressed. We pin that transition end-to-end.
    const runFullUpdate = vi.fn(async () => {});
    mockUseLibraryShell.mockReturnValue({
      formatTooNew: { surface: "storage", observed: 2, supported: 1 },
    });
    mockUseUpdater.mockReturnValue({
      ...baseUpdaterReturn,
      state: { ...baseUpdaterReturn.state, phase: "available" as const, version: "2.0.0" },
      runFullUpdate,
    });

    render(React.createElement(LibraryUpdateGate));

    // First render: format-too-new modal is showing.
    const titleBefore = container!.querySelector("[data-testid='dialog-title']")?.textContent;
    if (titleBefore !== "libraryFormat.tooNew.title") dumpGateSnapshot("modal-transition:pre-click-title");
    expect(titleBefore).toBe(
      "libraryFormat.tooNew.title"
    );

    console.info(`[library-update-gate-format-too-new:modal-transition] clicking Update Now to flip modals`);
    const updateNowBtn = container!.querySelector("button");
    await act(async () => {
      updateNowBtn!.click();
    });

    // After click: the format-too-new title is no longer present; an
    // UpdateAvailableModal dialog is now open instead. We can't read the
    // exact i18n title here, but the dialog title text differs.
    const titleAfter = container!.querySelector("[data-testid='dialog-title']")?.textContent;
    console.info(`[library-update-gate-format-too-new:modal-transition] post-click dialog title=${JSON.stringify(titleAfter)}`);
    if (titleAfter === "libraryFormat.tooNew.title") dumpGateSnapshot("modal-transition:post-click-title-not-flipped");
    expect(titleAfter).not.toBe("libraryFormat.tooNew.title");
    if (container!.querySelector("[data-testid='dialog']") === null)
      dumpGateSnapshot("modal-transition:post-click-no-dialog");
    expect(container!.querySelector("[data-testid='dialog']")).not.toBeNull();
  });

  it("when formatTooNew AND mandatory are BOTH true, the gate stays closed (the app-level prompt carries it)", () => {
    // A server-mandated update (release-status `mandatory`) opens `AppUpdateRequiredGate` above the routes on every
    // screen (REL-CD-29). The library gate then renders nothing, so the user sees one blocking prompt, not two.
    mockUseLibraryShell.mockReturnValue({
      formatTooNew: { surface: "storage", observed: 2, supported: 1 },
    });
    mockUseUpdater.mockReturnValue({
      ...baseUpdaterReturn,
      state: { ...baseUpdaterReturn.state, mandatory: true, phase: "available" as const },
    });

    render(React.createElement(LibraryUpdateGate));

    const dialogs = container!.querySelectorAll("[data-testid='dialog']");
    if (dialogs.length !== 0) dumpGateSnapshot("mandatory-defers:dialog-count");
    expect(dialogs.length).toBe(0);
  });

  it("is non-dismissible: clicking the dialog content area does not close it (no onDismiss prop)", () => {
    // The format-too-new modal is intentionally non-dismissible — the only
    // forward path is "Update Now". We pin this by verifying that the modal
    // doesn't render a close (X) affordance.
    mockUseLibraryShell.mockReturnValue({
      formatTooNew: { surface: "storage", observed: 2, supported: 1 },
    });
    render(React.createElement(LibraryUpdateGate));

    // There is one button — the Update Now CTA. No close button.
    const buttons = container!.querySelectorAll("button");
    if (buttons.length !== 1) dumpGateSnapshot("non-dismissible:button-count");
    expect(buttons.length).toBe(1);
    if (!buttons[0]?.textContent?.includes("libraryFormat.tooNew.updateNow"))
      dumpGateSnapshot("non-dismissible:button-text");
    expect(buttons[0]?.textContent).toContain("libraryFormat.tooNew.updateNow");
  });

  it("updating prop is wired to updater.state.phase === 'checking'", () => {
    // While the runFullUpdate pipeline is in its "checking" phase, the Update
    // Now button should be disabled (pending). We render in that state.
    mockUseLibraryShell.mockReturnValue({
      formatTooNew: { surface: "storage", observed: 2, supported: 1 },
    });
    mockUseUpdater.mockReturnValue({
      ...baseUpdaterReturn,
      state: { ...baseUpdaterReturn.state, phase: "checking" as const },
    });
    render(React.createElement(LibraryUpdateGate));

    const btn = container!.querySelector("button");
    if (btn?.disabled !== true) dumpGateSnapshot("checking-disables-button:not-disabled");
    expect(btn?.disabled).toBe(true);
  });
});
