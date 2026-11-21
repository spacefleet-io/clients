/**
 * @test-id BADGER-MOBILE-KEY-SAVED-WARNING-001
 * @level unit
 * @why Chris (2026-11-11): people who don't know what encryption is click through "store your key somewhere safe".
 *   The phone and TV "Your library key" screen (a new key, read-only) now has no confirm toggle, only
 *   "I've written it down", which opens a plain warning: only "Yes, I understand" creates the library; "Go back"
 *   returns to the same key. These tests mount the real screen for a brand-new account. Chris (2026-11-12): the
 *   screens that show and take the key were confusable, so this one is titled "Your library key" and has no field.
 *   Chris 2026-11-12 (chat): "the setup step to enter/save the key should be the same shared one between the 2 apps":
 *   the screen is the shared `MobileLibraryKeyStep` (its own test: MOBILE-SHELL-LIBRARY-KEY-STEP-001), so these tests
 *   pin what Badger hands it.
 * @req UX-KEY-01[badger-mobile,badger-tv]
 * @req ACCT-DEV-04[badger-mobile,badger-tv]
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnboardingKeyScreen } from "../src/screens/OnboardingKeyScreen";

const SUITE = "[BADGER-MOBILE-KEY-SAVED-WARNING-001]";

const ctl = vi.hoisted(() => ({
  stored: [] as string[],
  opened: [] as string[],
  acknowledged: 0,
  generated: 0,
  languages: [] as string[],
}));

vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T,>(styles: T) => styles },
}));
// The shared step as a host element carrying Badger's props; it renders the app's overlay (the warning) as the real one does.
vi.mock("@space/mobile-shell/library-key-step", () => ({
  MobileLibraryKeyStep: (props: { overlay?: React.ReactNode }) => React.createElement("MobileLibraryKeyStep", props, props.overlay),
}));
vi.mock("../src/components/Screen", () => ({
  Screen: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@space/mobile-shell/keyboard", () => ({
  KeyboardAvoidingForm: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@space/mobile-shell/key-saved-warning", () => ({ MobileKeySavedWarning: "MobileKeySavedWarning" }));
vi.mock("@space/mobile-shell/i18n", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
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
vi.mock("../src/lib/useSignOut", () => ({ useSignOut: () => async () => undefined }));
vi.mock("../src/setup/BadgerSetupFlow", () => ({ SetupStepBar: () => null }));
vi.mock("../src/screens/KeyFromAnotherDevice", () => ({ KeyFromAnotherDevice: () => null }));
// The new key: 12 words on screen, its derived key stored and used (the words themselves are never stored).
vi.mock("@space/shared/libraryKeyWords", async () => ({
  ...(await vi.importActual<object>("@space/shared/libraryKeyWords")),
  generateLibraryKeyWords: (language: string) => {
    ctl.generated += 1;
    ctl.languages.push(language);
    return { words: Array.from({ length: 12 }, (_, i) => `w${ctl.generated}-${i + 1}`), keyBase64: `NEW-KEY-${ctl.generated}` };
  },
}));
vi.mock("@space/mobile-shell/libraryKeyWords", () => ({
  LibraryKeyWordsGrid: "LibraryKeyWordsGrid",
  LibraryKeyWordsInput: "LibraryKeyWordsInput",
}));
vi.mock("../src/lib/onboarding", () => ({
  getStoredLibraryKey: async () => null,
  setStoredLibraryKey: async (key: string) => {
    ctl.stored.push(key);
  },
  clearLibraryKey: async () => undefined,
}));
vi.mock("../src/lib/crypto", () => ({ decryptBase64ToBytes: async () => new Uint8Array(32) }));
vi.mock("../src/lib/libraryDb", () => ({
  LibraryDb: {
    open: async (_token: string, key: string) => {
      ctl.opened.push(key);
      return { close: async () => undefined };
    },
  },
}));
// A brand-new account: the server never had a library, so the screen makes a key.
vi.mock("@space/shared/api", () => ({
  getLibraryMetaForKeyStep: async () => ({ exists: false, keyProbe: null, bootstrapRequired: true }),
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

const isType = (name: string) => (n: { type: unknown }) => n.type === name;
const warning = (root: ReactTestRenderer) => root.root.find(isType("MobileKeySavedWarning"));
const step = (root: ReactTestRenderer) => root.root.find(isType("MobileLibraryKeyStep"));

afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  ctl.stored.length = 0;
  ctl.opened.length = 0;
  ctl.acknowledged = 0;
  ctl.generated = 0;
  ctl.languages.length = 0;
});

describe("@req ACCT-DEV-04 Badger phone/TV new key: I've written it down, then the warning", () => {
  it("shows the new key under its own title, read-only, with no confirm toggle, the plain line and I've written it down", async () => {
    const root = await mount();
    const props = step(root).props;
    console.info(`${SUITE} step`, JSON.stringify({ mode: props.mode, title: props.title, continueLabel: props.continueLabel }), "warning visible", warning(root).props.visible);
    console.info(`${SUITE} grid words`, JSON.stringify(props.words), "language", JSON.stringify(ctl.languages));
    expect(props.mode).toBe("show");
    expect(props.words).toEqual(Array.from({ length: 12 }, (_, i) => `w1-${i + 1}`));
    expect(ctl.languages).toEqual(["en"]);
    expect(props.continueLabel).toBe("I've written it down");
    expect(props.canContinue).toBe(true);
    expect(typeof props.onRegenerate).toBe("function");
    expect(props.title).toBe("onboarding.showTitle");
    // A new key: no boxes, no other device (it has no library yet), no erase.
    expect(props.renderOtherDevice).toBeUndefined();
    expect(props.onErase).toBeUndefined();
    expect(String(props.body)).toContain("nobody, not even us, can get your media library back");
    expect(warning(root).props.visible).toBe(false);
  });

  it("makes a new key on Generate a new key", async () => {
    const root = await mount();
    await act(async () => step(root).props.onRegenerate());
    await flush();
    console.info(`${SUITE} after regenerate`, JSON.stringify(step(root).props.words), "stored", JSON.stringify(ctl.stored));
    expect(step(root).props.words[0]).toBe("w2-1");
    expect(ctl.stored).toEqual(["NEW-KEY-1", "NEW-KEY-2"]);
  });

  it("opens the warning, and Go back keeps the same key without creating the library", async () => {
    const root = await mount();
    await act(async () => step(root).props.onContinue());
    expect(warning(root).props.visible).toBe(true);
    expect(warning(root).props.text.needed).toBe("You'll need this key every time you sign in on a new device or app.");
    await act(async () => warning(root).props.onBack());
    await flush();
    console.info(`${SUITE} after Go back`, "visible", warning(root).props.visible, "opened", JSON.stringify(ctl.opened));
    expect(warning(root).props.visible).toBe(false);
    expect(step(root).props.words[0]).toBe("w1-1");
    expect(ctl.stored).toEqual(["NEW-KEY-1"]);
    expect(ctl.opened).toEqual([]);
    expect(ctl.acknowledged).toBe(0);
  });

  it("creates the library with the shown key only on Yes, I understand", async () => {
    const root = await mount();
    await act(async () => step(root).props.onContinue());
    await act(async () => warning(root).props.onConfirm());
    await flush();
    console.info(`${SUITE} after Yes`, "opened", JSON.stringify(ctl.opened), "acknowledged", ctl.acknowledged);
    expect(ctl.opened).toEqual(["NEW-KEY-1"]);
    expect(ctl.acknowledged).toBe(1);
  });
});
