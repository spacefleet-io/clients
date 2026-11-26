// @vitest-environment jsdom
/**
 * @test-id PARROT-DESKTOP-UNPAID-SETUP-001
 * @level unit
 * @req ACCT-UNPAID-06[parrot]
 * @why An unpaid account's key step failed with a network error: main's first library publish was refused with 402
 *   `subscription_unpaid`, and the step said "could not reach the server". The step now shows, in its place, that the
 *   plan has ended and the library can be set up once it is renewed, with Renew and Try again; Try again keeps the
 *   key, says "not renewed yet" while it is still refused, and goes on to the next step once the plan is paid again.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateLibraryKeyWords } from "@space/shared/libraryKeyWords";
import type { AccountKeyResult } from "@space/desktop-shell/account-key-check";
import type { ParrotState } from "../src/shared/ipc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SUITE = "[PARROT-DESKTOP-UNPAID-SETUP-001]";

vi.mock("../src/renderer/src/SignOutKeyCheck", () => ({ useSignOutWithKeyCheck: () => ({ requestSignOut: vi.fn(), dialog: null }) }));

import Setup from "../src/renderer/src/Setup";
import { translator } from "../src/renderer/src/i18n";

const state: ParrotState = {
  setup: { step: "libraryKey", done: false, language: "en", folders: [], startAtLogin: false, errorReports: false },
  user: { id: "u1", email: "parrot-test@example.test" },
  hasLibraryKey: false,
  asksKeySavedBeforeSignOut: false,
  apiBaseUrl: "https://api.example.test",
  isDevBuild: false,
  musicFolder: null,
  appVersion: "0.0.0",
};

const newKey = generateLibraryKeyWords("en", (bytes) => bytes.fill(9));
const UNPAID: AccountKeyResult = { ok: false, error: "unpaid", message: "subscription_unpaid" };

describe("ACCT-UNPAID-06: Parrot desktop's key step for an unpaid account", () => {
  let host: HTMLDivElement;
  let root: Root;
  let current: ParrotState;
  const createLibraryKey = vi.fn(async () => ({ ok: true as const, ...newKey }));
  const setLibraryKey = vi.fn(async (_key: string): Promise<AccountKeyResult> => UNPAID);
  const getState = vi.fn(async () => ({ ...state, hasLibraryKey: true }));
  const saveSetup = vi.fn(async (patch: Partial<ParrotState["setup"]>) => ({ ...current, setup: { ...current.setup, ...patch } }));
  const getSubscription = vi.fn(async () => ({ ok: false as const, code: "network" }));
  const t = translator("en");
  const q = (testId: string) => document.body.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
  const render = () => act(() => root.render(<Setup t={t} state={current} onState={(next) => ((current = next), render())} />));
  const flush = () =>
    act(async () => {
      for (let i = 0; i < 5; i += 1) {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 0);
        await promise;
      }
    });
  const dump = (label: string) =>
    console.info(
      `${SUITE} ${label}: unpaid=${q("unpaid-setup-step") !== null} title=${JSON.stringify(host.querySelector("h1")?.textContent ?? null)} message=${JSON.stringify(q("unpaid-setup-message")?.textContent ?? null)} keys=${setLibraryKey.mock.calls.length} saves=${JSON.stringify(saveSetup.mock.calls)}`,
    );
  const click = async (testId: string) => {
    await act(async () => q(testId)!.click());
    await flush();
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    setLibraryKey.mockImplementation(async () => UNPAID);
    current = state;
    (window as unknown as { parrot: unknown }).parrot = {
      pairing: { start: vi.fn(), poll: vi.fn(), cancel: vi.fn() },
      createLibraryKey,
      setLibraryKey,
      getState,
      saveSetup,
      getSubscription,
      getBillingStatus: vi.fn(async () => ({ ok: false, code: "network" })),
      getAccountAccess: vi.fn(async () => ({ ok: true, value: null })),
      onPaymentReturn: vi.fn((_listener: (paymentId: string) => void) => () => {}),
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => render());
    await flush();
    // A new account: the step shows the new key; keeping it publishes the first library, which the API refuses.
    await click("key-saved");
    await click("key-saved-warning-confirm");
    dump("refused");
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("says the plan ended in place of the step, with Renew and Try again, and keeps the key", async () => {
    expect(setLibraryKey).toHaveBeenCalledWith(newKey.keyBase64);
    expect(q("unpaid-setup-step")).not.toBeNull();
    expect(host.querySelector("h1")?.textContent).toBe("Your plan has ended");
    expect(host.textContent).toContain("Your library can be set up once your plan is renewed.");
    expect(q("unpaid-setup-renew")?.textContent).toBe("Renew");
    expect(host.textContent).not.toContain(t("key.error.network"));
    expect(saveSetup).not.toHaveBeenCalled();
  });

  it("Try again says the plan is not renewed yet while still refused, then goes on once it is paid", async () => {
    await click("unpaid-setup-try-again");
    dump("still unpaid");
    expect(setLibraryKey).toHaveBeenLastCalledWith(newKey.keyBase64);
    expect(q("unpaid-setup-message")?.textContent).toBe("Your plan is not renewed yet.");
    setLibraryKey.mockResolvedValueOnce({ ok: true });
    await click("unpaid-setup-try-again");
    dump("renewed");
    expect(q("unpaid-setup-step")).toBeNull();
    expect(saveSetup).toHaveBeenCalledWith({ step: "folders" });
  });

  it("Renew that cannot read the plan stays on the screen and says it is not renewed", async () => {
    await click("unpaid-setup-renew");
    dump("renew failed");
    expect(getSubscription).toHaveBeenCalledTimes(1);
    expect(q("unpaid-setup-step")).not.toBeNull();
    expect(q("unpaid-setup-message")?.textContent).toBe("Your plan is not renewed yet.");
  });
});
