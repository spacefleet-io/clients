/**
 * @test-id PARROT-MOBILE-UNPAID-SETUP-001
 * @level unit
 * @req ACCT-UNPAID-06[parrot,parrot-tv]
 * @why An unpaid account's new key could not be kept: claiming the account (its first library) was refused with 402
 *   `subscription_unpaid` and the step said it could not save the key. It now shows, in its place, the shared phone/TV
 *   screen that only informs (ACCT-PAY-02: no Renew, no payment words; its wording is pinned in
 *   `packages/shared/tests/unpaid-library-setup.test.ts`), keeps the new key, says the plan is not renewed yet when
 *   Try again is refused again, and saves that same key once the plan is renewed elsewhere. Back signs out.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MobileLibraryKeyStepProps } from "@space/mobile-shell/library-key-step";

const phone = vi.hoisted(() => ({
  keyProbe: null as string | null,
  saved: [] as string[],
  claims: [] as string[],
  unpaid: true,
  signedOut: 0,
}));
const seen = vi.hoisted(() => ({ step: null as null | Record<string, unknown>, unpaid: null as null | Record<string, unknown> }));

vi.mock("@space/mobile-shell/library-key-step", () => ({
  MobileLibraryKeyStep: (props: Record<string, unknown>) => {
    seen.step = props;
    return null;
  },
}));
// The shared screen renders for real in mobile-shell; here it keeps the props Parrot hands it.
vi.mock("@space/mobile-shell/unpaid-setup-step", () => ({
  MobileUnpaidSetupStep: (props: Record<string, unknown>) => {
    seen.unpaid = props;
    return null;
  },
}));
vi.mock("@space/mobile-shell/key-load-failed-step", () => ({ MobileKeyLoadFailedStep: () => null }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "de" } }) }));
vi.mock("@space/mobile-shell/key-saved-warning", () => ({ MobileKeySavedWarning: () => null }));
vi.mock("@space/mobile-shell/mascot-loader", () => ({ MobileMascotLoader: () => null }));
vi.mock("../src/brand", () => ({ PARROT_MASCOT: 1 }));
vi.mock("@space/mobile-shell/logger", () => ({ scopeLogger: () => ({ info: () => undefined, warn: () => undefined }) }));
// A new account: no key anywhere yet, so the step makes one.
vi.mock("@space/shared/api", () => ({
  getLibraryMetaForKeyStep: async () => ({ keyProbe: phone.keyProbe, exists: false }),
  resetLibrary: async () => ({ ok: true }),
}));
vi.mock("@space/mobile-shell/libraryEnvelope", () => ({ decryptBase64ToBytes: async () => new Uint8Array() }));
vi.mock("../src/state/session", () => ({
  useSession: () => ({
    session: { token: "phone-token" },
    saveLibraryKey: async (key: string) => {
      phone.saved.push(key);
    },
  }),
}));
// Claiming the account publishes its first library, which the API refuses while the plan has ended.
vi.mock("../src/lib/library", () => ({
  claimAccountKey: async (_token: string, key: string) => {
    phone.claims.push(key);
    if (phone.unpaid) throw Object.assign(new Error("subscription_unpaid"), { status: 402 });
    phone.keyProbe = key;
    return { version: 1 };
  },
}));
vi.mock("../src/state/useSignOut", () => ({
  useSignOut: () => async () => {
    phone.signedOut += 1;
  },
}));
vi.mock("../src/screens/PairingPanel", () => ({ KeyPairingPanel: () => null }));

import { LibraryKeyScreen } from "../src/screens/LibraryKeyScreen";

const SUITE = "[PARROT-MOBILE-UNPAID-SETUP-001]";

let renderer: ReactTestRenderer | null = null;
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await act(async () => void (await Promise.resolve()));
};
const step = () => seen.step as unknown as MobileLibraryKeyStepProps;
const unpaidStep = () => seen.unpaid!;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  seen.step = null;
  seen.unpaid = null;
  phone.keyProbe = null;
  phone.saved.length = 0;
  phone.claims.length = 0;
  phone.unpaid = true;
  phone.signedOut = 0;
});

describe("ACCT-UNPAID-06: Parrot phone and TV key step for an unpaid account", () => {
  it("informs in place of the step, keeps the new key, and saves it once the plan is renewed", async () => {
    await act(async () => {
      renderer = create(<LibraryKeyScreen />);
    });
    await flush();
    expect(step().mode).toBe("show");
    const confirm = (step().overlay as React.ReactElement<{ onConfirm: () => void }>).props.onConfirm;
    await act(async () => confirm());
    await flush();
    console.info(SUITE, "refused", JSON.stringify({ claims: phone.claims.length, saved: phone.saved, unpaid: seen.unpaid !== null }));
    const key = phone.claims[0];
    expect(unpaidStep().language).toBe("de");
    expect(unpaidStep().app).toBe("parrot");
    expect(unpaidStep().message).toBeNull();
    expect(Object.keys(unpaidStep())).not.toContain("onRenew");
    expect(phone.saved).toEqual([]);

    await act(async () => (unpaidStep().onTryAgain as () => void)());
    await flush();
    console.info(SUITE, "still unpaid", JSON.stringify({ claims: phone.claims, message: unpaidStep().message }));
    expect(phone.claims).toEqual([key, key]);
    expect(unpaidStep().message).toBe("Dein Tarif ist noch nicht verlängert.");
    expect(phone.saved).toEqual([]);

    phone.unpaid = false;
    await act(async () => (unpaidStep().onTryAgain as () => void)());
    await flush();
    console.info(SUITE, "renewed", JSON.stringify({ claims: phone.claims.length, saved: phone.saved.length }));
    expect(phone.claims.at(-1)).toBe(key);
    expect(phone.saved).toEqual([key]);
  });

  it("Back signs out", async () => {
    await act(async () => {
      renderer = create(<LibraryKeyScreen />);
    });
    await flush();
    const confirm = (step().overlay as React.ReactElement<{ onConfirm: () => void }>).props.onConfirm;
    await act(async () => confirm());
    await flush();
    await act(async () => (unpaidStep().onBack as () => void)());
    expect(phone.signedOut).toBe(1);
  });
});
