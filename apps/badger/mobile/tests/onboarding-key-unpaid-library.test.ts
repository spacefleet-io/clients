/**
 * @test-id BADGER-MOBILE-UNPAID-SETUP-001
 * @level unit
 * @req ACCT-UNPAID-06[badger-mobile,badger-tv]
 * @why An unpaid account whose key was made in Parrot had its first Badger library refused (402 `subscription_unpaid`):
 *   the key step threw the stored key away and asked for it again. The step now shows, in its place, the shared
 *   phone/TV screen that only informs (ACCT-PAY-02: no Renew, no payment words; its wording is pinned in
 *   `packages/shared/tests/unpaid-library-setup.test.ts`), keeps the key, says the plan is not renewed yet when Try
 *   again is refused again, and goes on with the same key once the plan is renewed elsewhere. Back signs out.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingKeyScreen } from "../src/screens/OnboardingKeyScreen";

const ctl = vi.hoisted(() => ({
  opened: [] as string[],
  cleared: [] as string[],
  acknowledged: 0,
  signedOut: 0,
  unpaid: true,
}));

vi.mock("react-native", async () => ({
  ...(await import("./setup/reactNativeMock")).reactNativeBase(),
  View: "View",
  Text: "Text",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
// The shared screen renders for real in mobile-shell; here it is a host element whose props are read.
vi.mock("@space/mobile-shell/unpaid-setup-step", () => ({
  MobileUnpaidSetupStep: (props: Record<string, unknown>) => React.createElement("MobileUnpaidSetupStep", props),
}));
vi.mock("@space/mobile-shell/library-key-step", () => ({
  MobileLibraryKeyStep: (props: Record<string, unknown>) => React.createElement("MobileLibraryKeyStep", props),
}));
vi.mock("@space/mobile-shell/keyboard", () => ({
  KeyboardAvoidingForm: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@space/mobile-shell/key-saved-warning", () => ({ MobileKeySavedWarning: () => null }));
vi.mock("@space/mobile-shell/components", () => ({
  MobilePhoneSignInCard: "MobilePhoneSignInCard",
  MobileScreen: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "fr" } }) }));
vi.mock("@space/mobile-shell/logger", () => ({
  scopeLogger: () => ({ info: () => undefined, error: () => undefined, warn: () => undefined }),
}));
vi.mock("../src/theme/theme", () => ({
  theme: new Proxy({}, { get: () => new Proxy({}, { get: () => ({}) }) }),
}));
vi.mock("../src/store/auth", () => ({ useAuth: () => ({ token: "token-1" }) }));
vi.mock("../src/store/library", () => ({
  useLibrary: () => ({
    acknowledgeKey: async () => {
      ctl.acknowledged += 1;
    },
    error: null,
  }),
}));
vi.mock("../src/lib/useSignOut", () => ({
  useSignOut: () => async () => {
    ctl.signedOut += 1;
  },
}));
vi.mock("../src/setup/BadgerSetupFlow", () => ({ SetupStepBar: () => null }));
vi.mock("../src/screens/KeyFromAnotherDevice", () => ({ KeyFromAnotherDevice: () => null }));
// The account's key, made in Parrot, is already stored here.
vi.mock("../src/lib/onboarding", () => ({
  getStoredLibraryKey: async () => "account-key",
  setStoredLibraryKey: async () => undefined,
  clearLibraryKey: async () => {
    ctl.cleared.push("key");
  },
}));
vi.mock("../src/lib/crypto", () => ({ decryptBase64ToBytes: async () => new Uint8Array(32) }));
vi.mock("../src/lib/libraryDb", () => ({
  LibraryDb: {
    open: async (_token: string, key: string) => {
      ctl.opened.push(key);
      // What the library's first publish throws for an unpaid account.
      if (ctl.unpaid) throw Object.assign(new Error("subscription_unpaid"), { status: 402 });
      return { close: async () => undefined };
    },
    clearLocalCache: async () => undefined,
  },
}));
// The key exists account-wide (Parrot's probe), but Badger has no library yet.
vi.mock("@space/shared/api", () => ({
  getLibraryMetaForKeyStep: async () => ({ exists: false, bootstrapRequired: true, keyProbe: "probe" }),
  resetLibrary: async () => ({ ok: true }),
}));

let tree: ReactTestRenderer | null = null;

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => undefined);
};
const step = () => tree!.root.findByType("MobileUnpaidSetupStep" as unknown as React.ElementType);

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  ctl.opened.length = 0;
  ctl.cleared.length = 0;
  ctl.acknowledged = 0;
  ctl.signedOut = 0;
  ctl.unpaid = true;
});

describe("ACCT-UNPAID-06: Badger phone and TV library step for an unpaid account", () => {
  it("informs in place of the step, keeps the key, and goes on with it once the plan is renewed", async () => {
    await act(async () => {
      tree = create(React.createElement(OnboardingKeyScreen));
    });
    await flush();
    const first = step().props;
    console.info("[BADGER-MOBILE-UNPAID-SETUP-001] refused", { opened: ctl.opened, cleared: ctl.cleared, language: first.language, app: first.app });
    expect(first.language).toBe("fr");
    expect(first.app).toBe("badger");
    expect(first.message).toBeNull();
    expect(Object.keys(first)).not.toContain("onRenew");
    expect(ctl.cleared).toEqual([]);
    expect(ctl.acknowledged).toBe(0);
    expect(tree!.root.findAllByType("MobileLibraryKeyStep" as unknown as React.ElementType)).toHaveLength(0);

    await act(async () => (step().props.onTryAgain as () => void)());
    await flush();
    console.info("[BADGER-MOBILE-UNPAID-SETUP-001] still unpaid", { opened: ctl.opened, message: step().props.message });
    expect(ctl.opened).toEqual(["account-key", "account-key"]);
    expect(step().props.message).toBe("L'abonnement n'est pas encore renouvelé.");

    ctl.unpaid = false;
    await act(async () => (step().props.onTryAgain as () => void)());
    await flush();
    console.info("[BADGER-MOBILE-UNPAID-SETUP-001] renewed", { opened: ctl.opened, acknowledged: ctl.acknowledged });
    expect(ctl.opened.at(-1)).toBe("account-key");
    expect(ctl.acknowledged).toBe(1);
    expect(tree!.root.findAllByType("MobileUnpaidSetupStep" as unknown as React.ElementType)).toHaveLength(0);
  });

  it("Back signs out", async () => {
    await act(async () => {
      tree = create(React.createElement(OnboardingKeyScreen));
    });
    await flush();
    await act(async () => (step().props.onBack as () => void)());
    expect(ctl.signedOut).toBe(1);
  });
});
