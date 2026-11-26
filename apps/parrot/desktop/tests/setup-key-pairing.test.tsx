// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-KEY-FROM-DEVICE-001
 * @level unit
 * @req ACCT-PAIR-01[parrot]
 * @why The setup key step (the shared LibraryKeyStep, in enter mode on an account that has a key) offers "Get the key
 *   from another device": it opens the shared pairing view in key mode; when main reports the key verified (and
 *   kept), setup reloads the state and moves on. A mismatch keeps the pairing view so the user can get a new code.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParrotPairedSignIn, ParrotState } from "../src/shared/ipc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-KEY-FROM-DEVICE-001]";

const pair = vi.hoisted(() => ({
  props: null as null | {
    mode?: string;
    language: string;
    onApproved: (approved: { status: "approved" } & ParrotPairedSignIn) => Promise<string>;
    onBack: () => void;
  },
}));

vi.mock("../src/renderer/src/SignOutKeyCheck", () => ({ useSignOutWithKeyCheck: () => ({ requestSignOut: vi.fn(), dialog: null }) }));
// The shared step renders the pairing view itself; only the props it gets matter here.
vi.mock("../../../../packages/desktop-shell/src/components/pair-with-phone", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  default: (props: NonNullable<typeof pair.props>) => {
    pair.props = props;
    return (
      <div data-testid="pair-with-phone" data-mode={props.mode}>
        <button data-testid="pair-back" onClick={props.onBack}>
          back
        </button>
      </div>
    );
  },
}));

import Setup from "../src/renderer/src/Setup";
import { translator } from "../src/renderer/src/i18n";

const state: ParrotState = {
  setup: { step: "libraryKey", done: false, language: "fr", folders: [], startAtLogin: false, errorReports: false },
  user: { id: "u1", email: "parrot-test@example.test" },
  hasLibraryKey: false,
  asksKeySavedBeforeSignOut: false,
  apiBaseUrl: "https://api.example.test",
  isDevBuild: false,
  musicFolder: null,
  appVersion: "0.0.0",
};

describe("@req ACCT-PAIR-01 Parrot desktop key step: get the key from another device", () => {
  let host: HTMLDivElement;
  let root: Root;
  let current: ParrotState;
  const getState = vi.fn(async () => ({ ...state, hasLibraryKey: true }));
  const saveSetup = vi.fn(async (patch: Partial<ParrotState["setup"]>) => ({ ...current, setup: { ...current.setup, ...patch } }));
  const q = (testId: string) => host.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  const render = () => act(() => root.render(<Setup t={translator("fr")} state={current} onState={(next) => ((current = next), render())} />));
  const dump = (label: string) =>
    console.info(
      `${SUITE} ${label}: link=${JSON.stringify(q("key-from-another-device")?.textContent ?? "none")} pair=${q("pair-with-phone")?.dataset.mode ?? "none"} step=${current.setup.step} getState=${getState.mock.calls.length} saves=${JSON.stringify(saveSetup.mock.calls)}`,
    );

  beforeEach(async () => {
    vi.clearAllMocks();
    pair.props = null;
    current = state;
    (window as unknown as { parrot: unknown }).parrot = {
      pairing: { start: vi.fn(), poll: vi.fn(), cancel: vi.fn() },
      // The account has a key: the step asks for it.
      createLibraryKey: vi.fn(async () => ({ ok: false, error: "hasLibrary" })),
      getState,
      saveSetup,
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => render());
    dump("mounted");
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("opens the shared pairing view in key mode, in the setup language, and goes back to typing", async () => {
    expect(q("key-from-another-device")?.textContent).toContain("Obtenir la clé depuis un autre appareil");
    await act(async () => q("key-from-another-device")!.click());
    dump("link-clicked");
    expect(q("pair-with-phone")?.dataset.mode).toBe("key");
    expect(pair.props?.language).toBe("fr");
    await act(async () => q("pair-back")!.click());
    dump("back");
    expect(q("pair-with-phone")).toBeNull();
    expect(host.querySelectorAll('[data-testid="library-key-box-input"]')).toHaveLength(12);
  });

  // @req UX-SETUP-08[parrot]
  it("keeps the language button in the window's top-right, Continue bottom-right, then an \"or\" line and the other-device card", () => {
    const menu = q("language-menu") ?? (host.querySelector('[aria-label*="angu"]') as HTMLElement | null);
    const controls = q("setup-libraryKey")?.parentElement?.querySelector(".fixed") as HTMLElement | null;
    console.info(`${SUITE} language controls=${JSON.stringify(controls?.className)} menu=${menu !== null}`);
    expect(controls).not.toBeNull();
    expect(controls!.className).toContain("right-8");
    expect(q("setup-libraryKey")!.contains(controls)).toBe(false);
    // UX-KEY-01: Continue, then the "or" line, then the card; no generic Next on the key step.
    const next = q("library-key-continue")!;
    const divider = q("key-other-device-divider")!;
    const card = q("key-from-another-device")!;
    console.info(`${SUITE} continue=${JSON.stringify(next?.textContent)} divider=${JSON.stringify(divider?.textContent)} card=${card?.tagName}`);
    expect(q("setup-next")).toBeNull();
    expect(card.tagName).toBe("BUTTON");
    expect(divider.textContent).toBe("ou");
    expect(next.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(divider.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The account has a key: no "create a key" line, only the lost-key erase.
    expect(q("key-create")).toBeNull();
    expect(q("key-lost-start-new-library")).not.toBeNull();
  });

  it("a verified key from main reloads the state and moves on to the folders", async () => {
    await act(async () => q("key-from-another-device")!.click());
    let check = "";
    await act(async () => {
      check = await pair.props!.onApproved({ status: "approved", check: "verified" });
    });
    dump("verified");
    expect(check).toBe("verified");
    expect(getState).toHaveBeenCalledTimes(1);
    expect(saveSetup).toHaveBeenCalledWith({ step: "folders" });
  });

  it("a mismatch keeps the pairing view and reloads nothing", async () => {
    await act(async () => q("key-from-another-device")!.click());
    let check = "";
    await act(async () => {
      check = await pair.props!.onApproved({ status: "approved", check: "mismatch" });
    });
    dump("mismatch");
    expect(check).toBe("mismatch");
    expect(getState).not.toHaveBeenCalled();
    expect(saveSetup).not.toHaveBeenCalled();
    expect(q("pair-with-phone")).not.toBeNull();
  });
});
