/**
 * @test-id BADGER-MOBILE-KEY-SCREEN-001
 * @level unit
 * @why Chris (2026-11-10): the "Media library key" screen showed a giant Paste button under the key field once the
 *   account already had a library. It only repeated the system paste every text field has, so it is gone, on the
 *   phone and on the TV (the same screen). Chris (2026-11-12): the key is typed as its 12 words. These tests mount
 *   the real screen in enter mode and pin that its only button is Validate key (Back signs out), that the words (any
 *   case, or their first 4 letters) are checked and the key they stand for is stored, that Validate key stays off
 *   while a word is unknown, and that the old base64 key, long-pressed in with spaces, line breaks and zero-width
 *   characters, still works. Chris (2026-11-12): the screens that show and take the key were confusable, so this one
 *   is titled "Enter your library key", its boxes start empty and it shows no grid of words. Chris 2026-11-12 (chat):
 *   "the setup step to enter/save the key should be the same shared one between the 2 apps": the screen is the
 *   shared `MobileLibraryKeyStep` (MOBILE-SHELL-LIBRARY-KEY-STEP-001 mounts it); these tests pin what Badger hands
 *   it, including the account-wide erase (Chris 2026-11-12 (chat): "they share the key and everything related to
 *   it") that clears this device and shows a new key to write down.
 * @req UX-TV-17[badger-tv]
 * @req UX-KEY-01[badger-mobile,badger-tv]
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateLibraryKeyWords } from "@space/shared/libraryKeyWords";
import { OnboardingKeyScreen } from "../src/screens/OnboardingKeyScreen";

const ctl = vi.hoisted(() => ({
  decrypted: [] as string[],
  stored: [] as string[],
  acknowledged: 0,
  signedOut: 0,
  reset: [] as unknown[][],
  resetError: null as Error | null,
  cleared: [] as string[],
  meta: { exists: true, bootstrapRequired: false, keyProbe: "probe" as string | null },
  probeKey: null as string | null,
  opened: [] as string[],
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
vi.mock("@space/mobile-shell/library-key-step", () => ({
  MobileLibraryKeyStep: (props: { overlay?: React.ReactNode }) => React.createElement("MobileLibraryKeyStep", props, props.overlay),
}));
vi.mock("../src/components/Screen", () => ({
  Screen: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@space/mobile-shell/keyboard", () => ({
  KeyboardAvoidingForm: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@space/mobile-shell/key-saved-warning", () => ({ MobileKeySavedWarning: () => null }));
vi.mock("@space/mobile-shell/components", () => ({ MobilePhoneSignInCard: "MobilePhoneSignInCard" }));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
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
// The setup step bar (UX-SETUP-03) has its own test (phone-setup-gate.test.ts).
vi.mock("../src/setup/BadgerSetupFlow", () => ({ SetupStepBar: () => null }));
vi.mock("../src/screens/KeyFromAnotherDevice", () => ({ KeyFromAnotherDevice: () => null }));
vi.mock("../src/lib/onboarding", () => ({
  getStoredLibraryKey: async () => null,
  setStoredLibraryKey: async (key: string) => {
    ctl.stored.push(key);
  },
  clearLibraryKey: async () => {
    ctl.cleared.push("key");
  },
}));
vi.mock("../src/lib/crypto", () => ({
  decryptBase64ToBytes: async (key: string) => {
    ctl.decrypted.push(key);
    // `probeKey` set: only that key opens the probe (the AES-GCM tag check fails for any other).
    if (ctl.probeKey && key !== ctl.probeKey) throw new Error("DECRYPT_FAILED");
    return new Uint8Array(32);
  },
}));
vi.mock("../src/lib/libraryDb", () => ({
  LibraryDb: {
    open: async (_token: string, key: string) => {
      ctl.opened.push(key);
      return { close: async () => undefined };
    },
    clearLocalCache: async () => {
      ctl.cleared.push("cache");
    },
  },
}));
vi.mock("@space/shared/api", () => ({
  getLibraryMetaForKeyStep: async () => ({ ...ctl.meta }),
  resetLibrary: async (...args: unknown[]) => {
    ctl.reset.push(args);
    if (ctl.resetError) throw ctl.resetError;
    return { ok: true };
  },
}));

let tree: ReactTestRenderer | null = null;

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => undefined);
};

const mount = async () => {
  await act(async () => {
    tree = create(React.createElement(OnboardingKeyScreen));
  });
  await flush();
  return tree!;
};

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  ctl.decrypted.length = 0;
  ctl.stored.length = 0;
  ctl.acknowledged = 0;
  ctl.signedOut = 0;
  ctl.reset.length = 0;
  ctl.resetError = null;
  ctl.cleared.length = 0;
  ctl.meta = { exists: true, bootstrapRequired: false, keyProbe: "probe" };
  ctl.probeKey = null;
  ctl.opened.length = 0;
});

describe("OnboardingKeyScreen, entering an existing key (BADGER-MOBILE-KEY-SCREEN-001)", () => {
  const step = (root: ReactTestRenderer) => root.root.find((n) => (n.type as unknown) === "MobileLibraryKeyStep");

  const typeKey = async (root: ReactTestRenderer, text: string) => {
    await act(async () => {
      step(root).props.onKeyChange(text);
    });
    return step(root);
  };

  const validate = async (root: ReactTestRenderer, text: string) => {
    const button = await typeKey(root, text);
    expect(button.props.canContinue).toBe(true);
    await act(async () => {
      await button.props.onContinue();
    });
    await flush();
    console.info("[BADGER-MOBILE-KEY-SCREEN-001] decrypted with", JSON.stringify(ctl.decrypted), "stored", JSON.stringify(ctl.stored));
  };

  it("hands the shared step enter mode under its own title, Validate key, the other-device panel and the erase", async () => {
    const root = await mount();
    const props = step(root).props;
    console.info(
      "[BADGER-MOBILE-KEY-SCREEN-001] step",
      JSON.stringify({ mode: props.mode, title: props.title, continueLabel: props.continueLabel, canContinue: props.canContinue }),
    );
    expect(props.mode).toBe("enter");
    expect(props.title).toBe("onboarding.enterTitle");
    expect(props.body).toBe("onboarding.subtitle");
    // The shared step's own "Continue" (no Validate key any more), the same in Badger and Parrot.
    expect(props.continueLabel).toBeUndefined();
    expect(props.canContinue).toBe(false);
    expect(props.onRegenerate).toBeDefined();
    // UX-KEY-01: "Get the key from another device" (ACCT-PAIR-01) is Badger's code panel; "Lost your key?" erases.
    expect(typeof props.renderOtherDevice).toBe("function");
    expect(typeof props.onErase).toBe("function");
    expect(props.error).toBeNull();
    // Back signs out: the step before the key is the sign-in (UX-SETUP-03); no separate Sign out button any more.
    await act(async () => props.onBack());
    expect(ctl.signedOut).toBe(1);
  });

  it("erases the account's library, clears this device, then shows a new key to write down", async () => {
    const root = await mount();
    await act(async () => step(root).props.onErase("pw", "123456"));
    await flush();
    const props = step(root).props;
    console.info("[BADGER-MOBILE-KEY-SCREEN-001] reset", JSON.stringify(ctl.reset), "cleared", JSON.stringify(ctl.cleared), "mode", props.mode);
    expect(ctl.reset).toEqual([["token-1", "pw", "123456"]]);
    expect(ctl.cleared).toEqual(["key", "cache"]);
    expect(props.mode).toBe("show");
    expect(props.words).toHaveLength(12);
    expect(ctl.stored).toHaveLength(1);
  });

  it("lets a failed erase reject unchanged for the dialog, and keeps the boxes", async () => {
    const root = await mount();
    const failure = Object.assign(new Error("invalid_password"), { status: 401 });
    ctl.resetError = failure;
    let caught: unknown = null;
    await act(async () => {
      await step(root).props.onErase("bad").catch((err: unknown) => {
        caught = err;
      });
    });
    console.info("[BADGER-MOBILE-KEY-SCREEN-001] failed erase", String(caught), "cleared", JSON.stringify(ctl.cleared));
    expect(caught).toBe(failure);
    expect(ctl.cleared).toEqual([]);
    expect(step(root).props.mode).toBe("enter");
  });

  it("checks and stores the key the 12 words stand for, typed in capitals or cut to 4 letters", async () => {
    const key = generateLibraryKeyWords("en");
    const typed = key.words.map((word, i) => (i % 2 ? word.toUpperCase() : word.slice(0, 4))).join("  ");
    console.info("[BADGER-MOBILE-KEY-SCREEN-001] words", key.words.join(" "), "typed", typed);
    const root = await mount();
    await validate(root, typed);
    expect(ctl.decrypted).toEqual([key.keyBase64]);
    expect(ctl.stored).toEqual([key.keyBase64]);
    expect(ctl.acknowledged).toBe(1);
  });

  it("keeps Validate key off while a word is unknown or words are missing", async () => {
    const key = generateLibraryKeyWords("en");
    const root = await mount();
    const unknown = await typeKey(root, ["zzzz", ...key.words.slice(1)].join(" "));
    console.info("[BADGER-MOBILE-KEY-SCREEN-001] unknown word, validate enabled", unknown.props.canContinue);
    expect(unknown.props.canContinue).toBe(false);
    const short = await typeKey(root, key.words.slice(0, 11).join(" "));
    expect(short.props.canContinue).toBe(false);
    expect(ctl.decrypted).toEqual([]);
  });

  it("still checks an old base64 key long-pressed in with spaces, line breaks and zero-width characters", async () => {
    const root = await mount();
    const key = "abcdEFGHijklMNOPqrstUVWXyz0123456789+/ABCDE=";
    const pasted = `\ufeff${key.slice(0, 4)} ${key.slice(4, 8)}\u200b${key.slice(8, 30)}\r\n${key.slice(30)}\u200d `;
    await validate(root, pasted);
    expect(ctl.decrypted).toEqual([key]);
    expect(ctl.stored).toEqual([key]);
    expect(ctl.acknowledged).toBe(1);
  });

  // Main 2026-11-12, from KeyProbeFix (791aa12f8): the API returns the account's key probe from either app, so a key
  // made in Parrot is checked here even with no Badger library yet; the same rule as Badger desktop (bd8b196c2).
  describe("a key made in Parrot (account probe set, no Badger library)", () => {
    const parrotOnly = (probeKey: string) => {
      ctl.meta = { exists: false, bootstrapRequired: true, keyProbe: "parrot-probe" };
      ctl.probeKey = probeKey;
    };

    it("asks for the key and never generates a new one", async () => {
      parrotOnly("unused");
      const root = await mount();
      const props = step(root).props;
      console.info("[BADGER-MOBILE-KEY-SCREEN-001] parrot-only probe: mode", props.mode, "words", props.words?.length, "stored", ctl.stored.length);
      expect(props.mode).toBe("enter");
      expect(props.words ?? []).toHaveLength(0);
      expect(ctl.stored).toEqual([]);
    });

    it("takes the right words: checked against the probe, stored, Badger's library created with that key", async () => {
      const key = generateLibraryKeyWords("en");
      parrotOnly(key.keyBase64);
      const root = await mount();
      await validate(root, key.words.join(" "));
      console.info("[BADGER-MOBILE-KEY-SCREEN-001] parrot-only ok: opened", JSON.stringify(ctl.opened), "error", step(root).props.error);
      expect(ctl.decrypted).toEqual([key.keyBase64]);
      expect(ctl.stored).toEqual([key.keyBase64]);
      expect(ctl.opened).toEqual([key.keyBase64]);
      expect(ctl.acknowledged).toBe(1);
      expect(step(root).props.error).toBeNull();
    });

    it("says the key doesn't match for wrong words, and stores nothing", async () => {
      parrotOnly(generateLibraryKeyWords("en").keyBase64);
      const wrong = generateLibraryKeyWords("en");
      const root = await mount();
      await validate(root, wrong.words.join(" "));
      console.info("[BADGER-MOBILE-KEY-SCREEN-001] parrot-only wrong: error", step(root).props.error);
      expect(step(root).props.error).toBe("libraryKeyStep.wrongKey");
      expect(ctl.stored).toEqual([]);
      expect(ctl.opened).toEqual([]);
      expect(ctl.acknowledged).toBe(0);
    });

    it("makes a new key only when no app has a probe and no library was ever made", async () => {
      ctl.meta = { exists: false, bootstrapRequired: true, keyProbe: null };
      const root = await mount();
      const props = step(root).props;
      console.info("[BADGER-MOBILE-KEY-SCREEN-001] no probe: mode", props.mode, "words", props.words?.length);
      expect(props.mode).toBe("show");
      expect(props.words).toHaveLength(12);
    });
  });
});
