// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-KEY-CHANGE-ROW-001
 * @level component (real KeyChangeRow and shared strings; the shared dialog stubbed to its props, `window.parrot` mocked)
 * @req ACCT-KEYCHG-01[parrot] ACCT-KEYCHG-03[parrot] ACCT-KEYCHG-04[parrot] ACCT-KEYCHG-08[parrot]
 * @why Parrot desktop offers "Replace media library key" in Settings › Account (Chris 2026-11-23 Q2), only once the
 *   server says it can be done (ACCT-KEYCHG-04, released on Parrot desktop per Main 2026-11-23 option C). The row drives
 *   the key change main runs: the new key's words, the code request, a refusal's words naming Badger (whose library is
 *   re-encrypted alongside), the switch to sign-in, no closing while files are copied, and a pause on leaving.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KeyChangeDialogProps } from "@space/desktop-shell/components";
import { KEY_CHANGE_IDLE, type KeyChangeState } from "@space/media-reseal";
import type { ParrotKeyChangeBridge, ParrotState } from "../src/shared/ipc";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-KEY-CHANGE-ROW-001]";

const dialog = vi.hoisted(() => ({ props: null as KeyChangeDialogProps | null }));
vi.mock("@space/desktop-shell/components", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/desktop-shell/components")>();
  return {
    ...actual,
    KeyChangeDialog: (props: KeyChangeDialogProps) => {
      dialog.props = props;
      return null;
    },
  };
});

import { KeyChangeRow } from "../src/renderer/src/KeyChangeRow";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let stateListener: ((state: KeyChangeState) => void) | null = null;

const bridge = (over: Partial<ParrotKeyChangeBridge> = {}): ParrotKeyChangeBridge => ({
  readiness: vi.fn(async () => ({ needsMediaReseal: true })),
  open: vi.fn(async () => ({ ok: true as const, words: ["alpha", "beta"], hasPassword: true })),
  submit: vi.fn(async () => ({ status: "switched" as const })),
  switchNow: vi.fn(async () => ({ status: "switched" as const })),
  poll: vi.fn(async () => ({ status: "waiting" as const })),
  stop: vi.fn(async () => ({ status: "stopped" as const })),
  pause: vi.fn(async () => undefined),
  unreadableFiles: vi.fn(async () => []),
  deleteUnreadableFiles: vi.fn(async () => true),
  onState: (listener) => {
    stateListener = listener;
    return () => {
      stateListener = null;
    };
  },
  ...over,
});

const signedOut: ParrotState = {
  setup: { step: "errorReports", done: true, language: "en", folders: [], startAtLogin: false, errorReports: false },
  user: null,
  hasLibraryKey: false,
  asksKeySavedBeforeSignOut: false,
  apiBaseUrl: "http://localhost:11000",
  isDevBuild: true,
  musicFolder: null,
  appVersion: "0.0.0",
};

const mount = async (keyChange: ParrotKeyChangeBridge | undefined, onState = vi.fn()) => {
  Object.defineProperty(window, "parrot", {
    configurable: true,
    value: keyChange ? { keyChange, getState: vi.fn(async () => signedOut) } : undefined,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<KeyChangeRow language="en" onState={onState} />);
  });
  await flush();
  return onState;
};

const flush = () =>
  act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });

const button = () => container!.querySelector<HTMLButtonElement>('[data-testid="settings-key-change"]');

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  dialog.props = null;
});

describe("@req ACCT-KEYCHG-04[parrot] Parrot desktop offers the key change once the server accepts it", () => {
  it(`${SUITE} the server accepts it: the row shows, with media too (Parrot desktop is released)`, async () => {
    await mount(bridge());
    expect(container!.textContent).toContain("Replace media library key");
    expect(button()?.textContent).toContain("Create new key");
  });

  it(`${SUITE} no answer from the server, or no bridge: no row`, async () => {
    await mount(bridge({ readiness: vi.fn(async () => null) }));
    expect(button()).toBeNull();
    act(() => root?.unmount());
    await mount(undefined);
    expect(container!.textContent).toBe("");
  });
});

describe("@req ACCT-KEYCHG-01[parrot] ACCT-KEYCHG-03[parrot] the row drives main's key change", () => {
  it(`${SUITE} opens with the new words, asks the code, says a refusal, then shows sign-in after the switch`, async () => {
    const submit = vi
      .fn<ParrotKeyChangeBridge["submit"]>()
      .mockResolvedValueOnce({ status: "codeNeeded", method: "email" })
      .mockResolvedValueOnce({ status: "failed", reason: "reencryptFailed" })
      .mockResolvedValueOnce({ status: "switched" });
    const onState = await mount(bridge({ submit }));
    await act(async () => button()!.click());
    await flush();
    expect(dialog.props).toMatchObject({ open: true, app: "Parrot", words: ["alpha", "beta"], hasPassword: true });

    await act(async () => dialog.props!.onPasswordChange("pw"));
    await act(async () => dialog.props!.onSubmit());
    expect(submit).toHaveBeenLastCalledWith("pw", undefined);
    expect(dialog.props).toMatchObject({ needsCode: true, method: "email" });
    expect(dialog.props!.notice).toBeTruthy();

    await act(async () => dialog.props!.onCodeChange("123456"));
    await act(async () => dialog.props!.onSubmit());
    expect(submit).toHaveBeenLastCalledWith("pw", "123456");
    // PRIV-KEY-06: on Parrot, the library re-encrypted alongside is Badger's.
    expect(dialog.props!.error).toContain("Badger");

    await act(async () => dialog.props!.onSubmit());
    expect(onState).toHaveBeenCalledWith(signedOut);
    expect(dialog.props!.open).toBe(false);
  });

  it(`${SUITE} while files are copied the code is spent and the dialog closes only through Stop`, async () => {
    const keyChange = bridge();
    await mount(keyChange);
    await act(async () => button()!.click());
    await flush();
    await act(async () => dialog.props!.onCodeChange("123456"));
    await act(async () => stateListener!({ ...KEY_CHANGE_IDLE, phase: "resealing" }));
    expect(dialog.props).toMatchObject({ code: "", needsCode: false });
    expect(dialog.props!.view.phase).toBe("resealing");

    await act(async () => dialog.props!.onOpenChange(false));
    expect(dialog.props!.open).toBe(true);

    await act(async () => dialog.props!.view.stop());
    expect(keyChange.stop).toHaveBeenCalled();
    expect(dialog.props!.open).toBe(false);
  });

  it(`${SUITE} leaving Settings pauses the copying`, async () => {
    const keyChange = bridge();
    await mount(keyChange);
    act(() => root?.unmount());
    root = null;
    expect(keyChange.pause).toHaveBeenCalled();
  });
});
