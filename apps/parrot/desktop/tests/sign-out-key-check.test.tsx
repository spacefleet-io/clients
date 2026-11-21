// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-SIGN-OUT-KEY-CHECK-001
 * @level integration (real Library and Setup screens, real Radix Dialog, real translator; `window.parrot` mocked)
 * @req ACCT-DEV-03
 * @why The user's own Sign out forgets the library key, and without the saved key the only way back in is typing it
 *   (QR-code sign-in needs another device that still holds the key). A Parrot desktop holding the key must ask first,
 *   Cancel must change nothing, and only "I saved it, sign out" may call `window.parrot.signOut()`. Without a key it
 *   signs out at once. Covers both Sign out buttons: the top-bar avatar menu's (UX-TOP-02) and Setup's "Use another
 *   account".
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { streamBridgeStub } from "./streamBridge";
import { profilesBridgeStub } from "./profilesBridge";
import type { ParrotState } from "../src/shared/ipc";
import Library from "../src/renderer/src/Library";
import Setup from "../src/renderer/src/Setup";
import { PARROT_STRINGS, translator } from "../src/renderer/src/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-SIGN-OUT-KEY-CHECK-001]";
const t = translator("en");
const en = PARROT_STRINGS.en;

const signedIn = (asksKeySavedBeforeSignOut: boolean, step: ParrotState["setup"]["step"] = "libraryKey"): ParrotState => ({
  setup: { step, done: step === "errorReports", language: "en", folders: [], startAtLogin: false, errorReports: false },
  user: { id: "u1", email: "parrot-test@example.test" },
  hasLibraryKey: asksKeySavedBeforeSignOut,
  asksKeySavedBeforeSignOut,
  apiBaseUrl: "http://localhost:11000",
  isDevBuild: true,
  musicFolder: null,
  appVersion: "0.0.0",
});
const signedOutState: ParrotState = { ...signedIn(false), user: null, hasLibraryKey: false };

const parrot = {
  ...streamBridgeStub(),
  ...profilesBridgeStub(),
  signOut: vi.fn(async () => signedOutState),
  getLibrary: vi.fn(async () => ({ ok: true, library: { snapshotVersion: 1, artists: [], albums: [], tracks: [] } })),
  getImportStatus: vi.fn(async () => ({ running: false, phase: "idle", done: 0, total: 0, imported: 0, skipped: 0, failed: 0 })),
  getImportScan: vi.fn(async () => null),
  getLyrics: vi.fn(async () => null),
  onLyricsChanged: vi.fn(() => () => undefined),
  onLibraryChanged: vi.fn(() => () => undefined),
  onLibraryPatch: vi.fn(() => () => undefined),
  onImportStatus: vi.fn(() => () => undefined),
  getCoversWaiting: vi.fn(async () => []),
  onCoversWaiting: vi.fn(() => () => undefined),
  getImportJobs: vi.fn(async () => []),
  onImportJobs: vi.fn(() => () => undefined),
  dismissImportJob: vi.fn(async () => []),
  getBackgroundWork: vi.fn(async () => []),
  onBackgroundWork: vi.fn(() => () => undefined),
  getKept: vi.fn(async () => ({ entries: [], songs: [], downloading: false })),
  onKept: vi.fn(() => () => undefined),
};

describe("@req ACCT-DEV-03 Parrot desktop Sign out asks whether the library key was saved", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onState: Mock<(state: ParrotState) => void>;

  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  const question = () => document.body.querySelector('[data-testid="sign-out-key-check"]');
  const buttonByText = (text: string) =>
    [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
  const dump = (label: string) =>
    console.info(
      `${SUITE} ${label}: question=${Boolean(question())} signOut=${parrot.signOut.mock.calls.length} onState=${onState.mock.calls.length} focused=${document.activeElement?.textContent?.trim() ?? "none"} buttons=${JSON.stringify([...document.body.querySelectorAll("button")].map((b) => b.textContent?.trim()))}`,
    );
  const mount = async (node: React.ReactNode) => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(node));
    await flush();
  };
  const click = async (testId: string) => {
    console.info(`${SUITE} phase=click ${testId}`);
    await act(async () => (document.body.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement).click());
    await flush();
  };
  /** The library's Sign out is the last entry of the top-bar avatar menu (UX-TOP-02). */
  const menuSignOut = async () => {
    await click("profile-menu");
    await click("profile-menu-sign-out");
  };

  beforeEach(() => {
    vi.clearAllMocks();
    onState = vi.fn();
    (window as unknown as { parrot: typeof parrot }).parrot = parrot;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("library Sign out on a key holder asks, Cancel (focused) keeps signed in, confirm signs out once", async () => {
    await mount(<Library t={t} state={signedIn(true, "errorReports")} onState={onState} />);
    await menuSignOut();
    dump("asked");
    expect(question()?.textContent).toContain(en["signOutKeyCheck.title"]);
    expect(question()?.textContent).toContain(en["signOutKeyCheck.body"]);
    expect(document.activeElement?.textContent?.trim()).toBe(en["signOutKeyCheck.cancel"]);
    // Parrot desktop cannot show the key: only Cancel and confirm (plus Radix's close icon).
    expect(buttonByText("Show my key")).toBeUndefined();
    expect(parrot.signOut).not.toHaveBeenCalled();

    await act(async () => buttonByText(en["signOutKeyCheck.cancel"])?.click());
    await flush();
    dump("cancelled");
    expect(question()).toBeNull();
    expect(parrot.signOut).not.toHaveBeenCalled();
    expect(onState).not.toHaveBeenCalled();

    await menuSignOut();
    await act(async () => buttonByText(en["signOutKeyCheck.confirm"])?.click());
    await flush();
    dump("confirmed");
    expect(parrot.signOut).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith(signedOutState);
  });

  it("library Sign out without a key signs out at once", async () => {
    await mount(<Library t={t} state={signedIn(false, "errorReports")} onState={onState} />);
    await menuSignOut();
    dump("no-key");
    expect(question()).toBeNull();
    expect(parrot.signOut).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith(signedOutState);
  });

  it("Setup's \"Use another account\" asks the same question on a key holder", async () => {
    await mount(<Setup t={t} state={signedIn(true)} onState={onState} />);
    await click("setup-sign-out");
    dump("setup-asked");
    expect(question()).not.toBeNull();
    expect(parrot.signOut).not.toHaveBeenCalled();
    await act(async () => buttonByText(en["signOutKeyCheck.confirm"])?.click());
    await flush();
    dump("setup-confirmed");
    expect(parrot.signOut).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenCalledWith(signedOutState);
  });

  it("ships the question in every Parrot desktop language", () => {
    for (const [lang, strings] of Object.entries(PARROT_STRINGS)) {
      const texts = ["title", "body", "cancel", "confirm"].map((k) => strings[`signOutKeyCheck.${k}` as keyof typeof strings]);
      console.info(`${SUITE} locale=${lang} ${JSON.stringify(texts)}`);
      for (const text of texts) expect(text).toBeTruthy();
    }
  });
});
