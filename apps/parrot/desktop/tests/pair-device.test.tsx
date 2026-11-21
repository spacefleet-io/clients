// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-PAIR-DEVICE-001
 * @level integration (real Library screen, real shared dialog, real main-process approver and real sealing; only the API
 *   is faked, and it checks the password the way the API does)
 * @req ACCT-PAIR-01
 * @req ACCT-PAIR-02
 * @why Parrot desktop approves a browser on the Parrot web player (or any new device) from the library's "Pair a device".
 *   The token and library key live in main, so the window drives the approver over IPC and must only ever see the
 *   request's name, type and expiry. The dialog must name the device and its type with the warning, a wrong password
 *   must leave the request pending, the right one must hand the browser a key it can open, and main must refuse to
 *   seal for a request it never looked up.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamBridgeStub } from "./streamBridge";
import { exportBridgeStub } from "./exportBridge";
import {
  bytesToBase64,
  generateDeviceKeyPair,
  openSealedKey,
  type DeviceKeyPair,
  type PairingRequestInfo,
  type SealedKey,
} from "@space/pairing-crypto";
import type { ParrotState } from "../src/shared/ipc";
import Library from "../src/renderer/src/Library";
import { pairDeviceStrings } from "@space/desktop-shell/components";
import { PARROT_STRINGS, translator } from "../src/renderer/src/i18n";
import { createParrotPairingApprover, type ParrotPairingApprover } from "../src/main/pairingApprove";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-PAIR-DEVICE-001]";
const t = translator("en");
const en = PARROT_STRINGS.en;
const dialogEn = pairDeviceStrings.en;
const LIBRARY_KEY = bytesToBase64(Uint8Array.from({ length: 32 }, (_, i) => 100 + i));
const PASSWORD = "correct horse";
const apiError = (status: number, error: string) => Object.assign(new Error(error), { status, payload: { error } });

const state: ParrotState = {
  setup: { step: "errorReports", done: true, language: "en", folders: [], startAtLogin: false, errorReports: false },
  user: { id: "u1", email: "parrot-test@example.test" },
  hasLibraryKey: true,
  asksKeySavedBeforeSignOut: true,
  apiBaseUrl: "http://localhost:11000",
  isDevBuild: true,
  musicFolder: null,
  appVersion: "0.0.0",
};

describe("@req ACCT-PAIR-01 @req ACCT-PAIR-02 Parrot desktop approves a new device from the library", () => {
  let container: HTMLDivElement;
  let root: Root;
  let browser: DeviceKeyPair;
  let requestState: "pending" | "approved" | "denied";
  let sealed: SealedKey | null;
  let mainLog: string[];
  let windowSaw: unknown[];
  let approver: ParrotPairingApprover;
  let request: PairingRequestInfo;

  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0));
    });
  };
  const q = (testId: string) => document.body.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  const click = async (testId: string) => {
    console.info(`${SUITE} phase=click ${testId}`);
    await act(async () => (q(testId) as HTMLButtonElement).click());
    await flush();
  };
  const type = async (testId: string, value: string) => {
    const input = q(testId) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = async (testId: string) => {
    await act(async () => (q(testId) as HTMLFormElement).requestSubmit());
    await flush();
  };
  const dump = (label: string) =>
    console.info(
      `${SUITE} ${label}: state=${requestState} sealed=${Boolean(sealed)} error=${q("pair-approve-error")?.textContent ?? "none"} result=${q("pair-approve-result")?.textContent ?? "none"} main=${JSON.stringify(mainLog)}`,
    );

  beforeEach(() => {
    browser = generateDeviceKeyPair();
    requestState = "pending";
    sealed = null;
    mainLog = [];
    windowSaw = [];
    request = {
      requestId: "req-web",
      app: "parrot",
      deviceType: "web",
      deviceName: "Firefox on Linux",
      publicKey: browser.publicKey,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
    approver = createParrotPairingApprover({
      token: () => "parrot-session",
      libraryKey: () => LIBRARY_KEY,
      api: {
        lookup: vi.fn(async (token: string, code: string) => {
          expect(token).toBe("parrot-session");
          if (code !== "ABCDEFGH" || requestState !== "pending") throw apiError(404, "pairing_not_found");
          return request;
        }),
        approve: vi.fn(async (_token: string, _id: string, sealedKey: SealedKey, password: string) => {
          if (requestState !== "pending") throw apiError(409, "pairing_already_used");
          if (password !== PASSWORD) throw apiError(401, "invalid_password");
          requestState = "approved";
          sealed = sealedKey;
          return { ok: true, sessionId: "sess-web" };
        }),
        deny: vi.fn(async () => {
          requestState = "denied";
          return { ok: true };
        }),
      },
      log: (line) => mainLog.push(line),
    });
    // The preload bridge: what crosses IPC is recorded, so the test sees exactly what the window gets.
    const seen = async <T,>(result: Promise<T>) => {
      const value = await result;
      windowSaw.push(value);
      return value;
    };
    (window as unknown as { parrot: unknown }).parrot = {
      ...streamBridgeStub(),
      ...exportBridgeStub(),
      lookupPairing: (code: string) => seen(approver.lookup(code)),
      approvePairing: (requestId: string, password: string) => seen(approver.approve(requestId, password)),
      denyPairing: (requestId: string) => seen(approver.deny(requestId)),
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
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  const openDialog = async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Library t={t} state={state} onSignedOut={() => undefined} />));
    await flush();
    // "Pair a device" lives in Settings › Account (PAR-NAV-01, UX-SET-01).
    await click("nav-settings");
    await click("settings-nav-account");
    expect(q("library-pair-device")?.textContent).toBe(en["library.pairDevice"]);
    await click("library-pair-device");
    expect(q("pair-approve-dialog")).not.toBeNull();
    await type("pair-approve-code", "abcd-efgh");
    await submit("pair-approve-code-step");
    dump("looked-up");
  };

  it("names the browser with the warning; wrong password keeps it pending; right one hands over a key it opens", async () => {
    await openDialog();
    expect(q("pair-approve-question")?.textContent).toBe("Parrot on Firefox on Linux (Web browser) wants to sign in to your account.");
    expect(q("pair-approve-warning")?.textContent).toContain(dialogEn["confirm.warning"]);
    // The window got the view only: never the browser's public key, the token or the library key.
    expect(JSON.stringify(windowSaw)).not.toContain(browser.publicKey);
    expect(JSON.stringify(windowSaw)).not.toContain(LIBRARY_KEY);
    expect(JSON.stringify(windowSaw)).not.toContain("parrot-session");

    await type("pair-approve-password", "wrong");
    await submit("pair-approve-confirm-step");
    dump("wrong-password");
    expect(q("pair-approve-error")?.textContent).toBe(dialogEn["errors.wrong_password"]);
    expect(requestState).toBe("pending");
    expect(q("pair-approve-confirm-step")).not.toBeNull();

    await type("pair-approve-password", PASSWORD);
    await submit("pair-approve-confirm-step");
    dump("approved");
    expect(requestState).toBe("approved");
    expect(q("pair-approve-result")?.textContent).toContain("Firefox on Linux is signed in to your account.");
    expect(sealed).not.toBeNull();
    const opened = openSealedKey({ sealed: sealed as SealedKey, devicePrivateKey: browser.privateKey, requestId: "req-web" });
    expect(bytesToBase64(opened)).toBe(LIBRARY_KEY);
    expect(mainLog).toContain("[pairing] approve: ok");
  });

  it("a key-only request from another signed-in device reads 'wants your media library key'", async () => {
    request = { ...request, app: "badger", deviceType: "desktop", deviceName: "test-laptop", purpose: "key" };
    await openDialog();
    const question = q("pair-approve-question")?.textContent;
    console.info(`${SUITE} key-purpose question=${question}`);
    expect(question).toBe("Badger on test-laptop (Computer) is signed in to your account and wants your media library key.");
    await type("pair-approve-password", PASSWORD);
    await submit("pair-approve-confirm-step");
    dump("key-approved");
    expect(requestState).toBe("approved");
    expect(q("pair-approve-result")?.textContent).toContain("test-laptop has your media library key.");
  });

  it("Decline denies the request and the code stops working", async () => {
    await openDialog();
    await click("pair-approve-deny");
    dump("denied");
    expect(requestState).toBe("denied");
    expect(q("pair-approve-result")?.textContent).toContain("Firefox on Linux was declined.");
    expect(sealed).toBeNull();
  });

  it("main refuses to seal for a request this window never looked up", async () => {
    const result = await approver.approve("req-forged", PASSWORD);
    console.info(`${SUITE} forged=${JSON.stringify(result)}`);
    expect(result).toEqual({ ok: false, kind: "not_found" });
    expect(sealed).toBeNull();
  });

  it("ships the button and the shared dialog in every Parrot desktop language", () => {
    for (const [lang, strings] of Object.entries(PARROT_STRINGS)) {
      const dialog = pairDeviceStrings[lang as keyof typeof pairDeviceStrings];
      const missing = Object.keys(dialogEn).filter((key) => !dialog[key as keyof typeof dialog]);
      if (!strings["library.pairDevice"]) missing.push("library.pairDevice");
      console.info(`${SUITE} locale=${lang} missing=${JSON.stringify(missing)}`);
      expect(missing).toEqual([]);
    }
  });
});
