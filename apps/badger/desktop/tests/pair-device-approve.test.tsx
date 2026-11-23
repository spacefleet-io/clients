// @vitest-environment jsdom
/**
 * ACCT-PAIR-01 / ACCT-PAIR-02: approving another device (a TV here) from the desktop settings. The dialog runs the
 * real approver logic and the real sealing; only the API is faked, and the fake checks the password the way the API
 * does (a wrong one is 401 `invalid_password` and leaves the request pending).
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  bytesToBase64,
  formatCheckCode,
  generateDeviceKeyPair,
  newPairingNonce,
  openSealedKey,
  pairingCheckCode,
  pairingCommitment,
  type DeviceKeyPair,
  type SealedKey,
} from "@space/pairing-crypto";
import { pairDeviceStrings } from "@space/desktop-shell/components";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const en = pairDeviceStrings.en;

const i18n = vi.hoisted(() => ({
  language: "en",
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ i18n }) }));
vi.mock("@space/ui", () => {
  const passthrough =
    (tag: string) =>
    ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
      React.createElement(tag, props, children);
  return {
    Button: ({ children, variant: _v, size: _s, ...props }: Record<string, unknown> & { children?: React.ReactNode }) => (
      <button {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}>{children}</button>
    ),
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    Label: passthrough("label"),
    Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) => (open ? <div>{children}</div> : null),
    DialogContent: passthrough("div"),
    DialogDescription: passthrough("p"),
    DialogFooter: passthrough("div"),
    DialogHeader: passthrough("div"),
    DialogTitle: passthrough("h2"),
  };
});
vi.mock("@/logger", () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log };
  return { rendererLogger: log };
});
vi.mock("@/lib/onboarding", () => ({ getStoredLibraryKey: vi.fn() }));
vi.mock("@space/shared/api", () => ({
  approvePairing: vi.fn(),
  connectPairing: vi.fn(),
  denyPairing: vi.fn(),
  lookupPairing: vi.fn(),
  readPairingReveal: vi.fn(),
}));
vi.mock("@/api", () => ({ getLibraryMeta: vi.fn() }));
vi.mock("@/lib/crypto", () => ({ decryptBase64ToBytes: vi.fn() }));
const account = vi.hoisted(() => ({ hasPassword: true }));
vi.mock("@/auth", () => ({ useHasPassword: () => account.hasPassword }));

import PairDeviceDialog from "../src/renderer/src/components/settings/PairDeviceDialog";
import type { ApprovePairingDeps } from "@space/pairing-crypto";

const LIBRARY_KEY = bytesToBase64(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const ACCOUNT_PASSWORD = "correct horse";
const EMAILED_CODE = "482913";

const apiError = (status: number, error: string) => Object.assign(new Error(error), { status, payload: { error } });

describe("PairDeviceDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let tv: DeviceKeyPair;
  let state: "pending" | "approved" | "denied";
  let sealedForTv: SealedKey | null;
  let deps: ApprovePairingDeps & {
    lookup: Mock;
    approve: Mock;
    deny: Mock;
    getLibraryKey: Mock;
    keyOpensAccount: Mock;
    connect: Mock;
    readReveal: Mock;
  };
  /** PRIV-PAIR-01: the TV's secret number, and the number this computer connected with. */
  let tvNonce: string;
  let connectedNonce: string | null;
  const onApproved = vi.fn();

  const text = () => container.textContent ?? "";
  const byTestId = <T extends Element>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`);
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement | undefined;
  const type = async (id: string, value: string) => {
    const input = byTestId<HTMLInputElement>(id)!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const submit = async (id: string) => {
    await act(async () => {
      byTestId<HTMLFormElement>(id)!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
  };
  const enterCode = async (code = "abcd-efgh") => {
    await type("pair-approve-code", code);
    await submit("pair-approve-code-step");
  };
  const approveWith = async (password: string) => {
    await type("pair-approve-password", password);
    await submit("pair-approve-confirm-step");
  };

  const render = async () => {
    await act(async () => {
      root.render(<PairDeviceDialog open onOpenChange={() => undefined} token="desk-token" deps={deps} onApproved={onApproved} />);
    });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    account.hasPassword = true;
    tv = generateDeviceKeyPair();
    state = "pending";
    sealedForTv = null;
    tvNonce = newPairingNonce();
    connectedNonce = null;
    deps = {
      lookup: vi.fn(async (_token: string, code: string) => {
        if (code !== "ABCDEFGH" || state !== "pending") throw apiError(404, "pairing_not_found");
        return {
          requestId: "req-tv",
          deviceType: "tv",
          deviceName: "Salon",
          publicKey: tv.publicKey,
          protocol: 2 as const,
          commitment: pairingCommitment(tv.publicKey, tvNonce),
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        };
      }),
      approve: vi.fn(async (_token: string, _requestId: string, sealedKey: SealedKey, password: string | undefined, twoFactorCode?: string) => {
        if (state !== "pending") throw apiError(409, "pairing_already_used");
        if (account.hasPassword) {
          if (password !== ACCOUNT_PASSWORD) throw apiError(401, "invalid_password");
        } else if (!twoFactorCode) {
          // ACCT-AUTH-04: like the API, a code-less try emails one and says so.
          throw Object.assign(new Error("two_factor_required"), { status: 401, payload: { error: "two_factor_required", method: "email" } });
        } else if (twoFactorCode !== EMAILED_CODE) {
          throw Object.assign(new Error("two_factor_invalid"), { status: 401, payload: { error: "two_factor_invalid", method: "email" } });
        }
        state = "approved";
        sealedForTv = sealedKey;
        return { ok: true, sessionId: "sess-tv" };
      }),
      deny: vi.fn(async () => {
        state = "denied";
        return { ok: true };
      }),
      getLibraryKey: vi.fn(async () => LIBRARY_KEY),
      keyOpensAccount: vi.fn(async () => true),
      connect: vi.fn(async (_token: string, _id: string, nonce: string) => {
        connectedNonce = nonce;
        return { ok: true };
      }),
      // The TV reveals its number once this computer connected.
      readReveal: vi.fn(async () => (connectedNonce ? { status: "pending", requesterNonce: tvNonce } : { status: "pending" })),
      now: () => Date.now(),
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await render();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("@req ACCT-PAIR-01 @req PRIV-KEY-05 approves a TV by its typed code and hands it the library key, sealed for that TV only", async () => {
    await enterCode();
    await approveWith(ACCOUNT_PASSWORD);

    expect(state).toBe("approved");
    expect(deps.approve).toHaveBeenCalledWith("desk-token", "req-tv", expect.any(Object), ACCOUNT_PASSWORD, undefined);
    // The API only ever sees the sealed box; the TV opens it with its own private key.
    expect(JSON.stringify(sealedForTv)).not.toContain(LIBRARY_KEY);
    const opened = openSealedKey({ sealed: sealedForTv!, devicePrivateKey: tv.privateKey, requestId: "req-tv" });
    expect(bytesToBase64(opened)).toBe(LIBRARY_KEY);
    expect(text()).toContain("Salon is signed in to your account.");
    expect(onApproved).toHaveBeenCalledTimes(1);
  });

  it("@req ACCT-PAIR-02 @req ACCT-PAIR-05 names the asking app, the device and its type with the warning before anything is sent", async () => {
    await enterCode();

    // The mocked lookup sends no `app` (an older API): the request is Badger's.
    const question = byTestId("pair-approve-question")?.textContent;
    console.info("[pair-approve-question]", question);
    expect(question).toBe("Badger on Salon (TV) wants to sign in to your account.");
    expect(byTestId("pair-approve-warning")?.textContent).toBe(en["confirm.warning"]);
    expect(deps.approve).not.toHaveBeenCalled();
    // PRIV-PAIR-02 reads the key to check it against the account, but nothing is sealed before the password.
    expect(sealedForTv).toBeNull();
  });

  it("@req ACCT-PAIR-01 a signed-in device asking only for the key reads 'wants your media library key'", async () => {
    const pending = deps.lookup.getMockImplementation()!;
    deps.lookup.mockImplementation(async (token: string, code: string) => ({
      ...(await pending(token, code)),
      app: "parrot",
      deviceType: "desktop",
      deviceName: "test-laptop",
      purpose: "key",
    }));
    await enterCode();
    const question = byTestId("pair-approve-question")?.textContent;
    console.info("[pair-approve-key-question]", question);
    expect(question).toBe("Parrot on test-laptop (Computer) is signed in to your account and wants your media library key.");
    await approveWith(ACCOUNT_PASSWORD);
    console.info("[pair-approve-key-done]", text());
    expect(text()).toContain("test-laptop has your media library key.");
  });

  it("@req ACCT-PAIR-02 refuses a wrong account password, keeps the request pending and lets the user retry", async () => {
    await enterCode();
    await approveWith("wrong");

    expect(state).toBe("pending");
    expect(text()).toContain(en["errors.wrong_password"]);
    expect(byTestId<HTMLInputElement>("pair-approve-password")?.value).toBe("");
    expect(onApproved).not.toHaveBeenCalled();

    await approveWith(ACCOUNT_PASSWORD);
    expect(state).toBe("approved");
  });

  it("@req ACCT-PAIR-02 sends nothing without the account password", async () => {
    await enterCode();
    await submit("pair-approve-confirm-step");

    expect(deps.approve).not.toHaveBeenCalled();
    expect(button(en["confirm.approve"])?.disabled).toBe(true);
  });

  it("@req ACCT-PAIR-02 declining kills the code", async () => {
    await enterCode();
    await act(async () => button(en["confirm.deny"])?.click());

    expect(state).toBe("denied");
    expect(deps.approve).not.toHaveBeenCalled();
    expect(text()).toContain("Salon was declined. Its code no longer works.");
  });

  it("@req ACCT-PAIR-02 rejects a malformed code locally and an unknown or used one from the API", async () => {
    // ACCT-PAIR-01: the code field keeps only a canonical code, so a short one never reaches the API: Continue stays off.
    await enterCode("hello");
    expect(deps.lookup).not.toHaveBeenCalled();
    expect(button(en["code.submit"])?.disabled).toBe(true);
    expect(byTestId("pair-approve-confirm-step")).toBeNull();

    await enterCode("ZZZZ-ZZZZ");
    expect(text()).toContain(en["errors.not_found"]);
    expect(byTestId("pair-approve-confirm-step")).toBeNull();
  });

  it("@req ACCT-PAIR-02 does not approve a code that expired while the dialog was open", async () => {
    deps.lookup.mockResolvedValueOnce({
      requestId: "req-tv",
      deviceType: "tv",
      deviceName: "Salon",
      publicKey: tv.publicKey,
      protocol: 2,
      commitment: pairingCommitment(tv.publicKey, tvNonce),
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
    });
    await enterCode();
    deps.now = () => Date.now() + 5_000;
    await approveWith(ACCOUNT_PASSWORD);

    expect(deps.approve).not.toHaveBeenCalled();
    expect(text()).toContain(en["errors.expired"]);
  });

  it("@req ACCT-PAIR-01 says so when this computer has no library key to pass on", async () => {
    deps.getLibraryKey.mockResolvedValue(null);
    await enterCode();

    // Found before the check: nothing is connected, sealed or sent.
    expect(deps.connect).not.toHaveBeenCalled();
    expect(deps.approve).not.toHaveBeenCalled();
    expect(text()).toContain(en["errors.no_library_key"]);
  });

  it("@req PRIV-PAIR-01 [pair-approve-check] shows the same six digits as the TV before the password", async () => {
    await enterCode();
    const tvCode = pairingCheckCode({ publicKey: tv.publicKey, commitment: pairingCommitment(tv.publicKey, tvNonce), approverNonce: connectedNonce!, requesterNonce: tvNonce });
    const shown = byTestId("pair-approve-check-code")?.textContent;
    console.info("[pair-approve-check]", { shown, tvCode, question: byTestId("pair-approve-check")?.textContent });
    expect(shown).toBe(formatCheckCode(tvCode));
    expect(byTestId("pair-approve-check")?.textContent).toContain("Does Salon show this code?");
    // The user says no: Decline kills the request and nothing is sealed.
    await act(async () => byTestId<HTMLButtonElement>("pair-approve-deny")!.click());
    expect(state).toBe("denied");
    expect(sealedForTv).toBeNull();
  });

  it("@req PRIV-PAIR-02 [pair-approve-stale] a computer whose key the account no longer opens sends nothing", async () => {
    deps.keyOpensAccount.mockResolvedValue(false);
    await enterCode();
    console.info("[pair-approve-stale]", text());
    expect(text()).toContain(en["errors.stale_key"]);
    expect(deps.connect).not.toHaveBeenCalled();
    expect(deps.approve).not.toHaveBeenCalled();
  });

  it("@req PRIV-PAIR-04 [pair-approve-v1] a device from before the check is asked to update", async () => {
    deps.lookup.mockResolvedValue({
      requestId: "req-tv",
      deviceType: "tv",
      deviceName: "Salon",
      publicKey: tv.publicKey,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    await enterCode();
    console.info("[pair-approve-v1]", text());
    expect(text()).toContain(en["errors.update_required"]);
    expect(deps.connect).not.toHaveBeenCalled();
  });

  it("@req ACCT-AUTH-04[badger-desktop] @req ACCT-PAIR-02 an account without a password approves with the emailed code", async () => {
    account.hasPassword = false;
    await render();
    await enterCode();
    console.info("[pair-approve-nopw] phase=confirm", text());
    expect(byTestId("pair-approve-password")).toBeNull();
    expect(byTestId("pair-approve-no-password")?.textContent).toBe(en["confirm.noPasswordHint"]);

    // The first Approve sends no code; the API emails one and the code field appears.
    await submit("pair-approve-confirm-step");
    console.info("[pair-approve-nopw] phase=code-asked", text());
    expect(deps.approve).toHaveBeenLastCalledWith("desk-token", "req-tv", expect.any(Object), undefined, "");
    expect(state).toBe("pending");
    expect(byTestId("pair-approve-code-notice")?.textContent).toBe(en["confirm.codeSentEmail"]);

    await type("pair-approve-proof-code", "000000");
    await submit("pair-approve-confirm-step");
    console.info("[pair-approve-nopw] phase=wrong-code", text());
    expect(state).toBe("pending");
    expect(text()).toContain(en["errors.wrong_code"]);
    expect(byTestId("pair-approve-proof-code")).not.toBeNull();

    await type("pair-approve-proof-code", ` ${EMAILED_CODE} `);
    await submit("pair-approve-confirm-step");
    console.info("[pair-approve-nopw] phase=approved", text());
    expect(deps.approve).toHaveBeenLastCalledWith("desk-token", "req-tv", expect.any(Object), undefined, EMAILED_CODE);
    expect(state).toBe("approved");
    expect(onApproved).toHaveBeenCalledTimes(1);
  });
});
