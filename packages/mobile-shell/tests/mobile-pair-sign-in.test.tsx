/**
 * @test-id MOBILE-SHELL-PAIR-SIGN-IN-001
 * @level unit
 * @req UX-PHONE-10[badger-mobile,parrot]
 * @req ACCT-SIGNIN-04[badger-mobile,parrot]
 * @req ACCT-PAIR-01[badger-mobile,parrot]
 * @why Badger's and Parrot's phones show one "Sign in with another device" page, built to the mockup Chris approved on
 *   2026-11-18: Back on top, the app's mascot, the live QR code, the code in two halves of boxes that fit the phone, a pulsing "waiting"
 *   dot, a countdown bar and "New code in m:ss" that follow the code's real expiry, and "How does this work?" opening
 *   the shared bottom sheet. No "Sign in with email and password" link: Back does that.
 */
import { createElement, type ReactNode } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const back = vi.hoisted(() => ({ listeners: [] as Array<() => boolean> }));
const sheet = vi.hoisted(() => ({ close: vi.fn() }));

vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Image: "Image",
  Platform: { OS: "android" },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: "Text",
  View: "View",
  // An iPhone 16's width (the mockup's frame); the OnePlus 9 is 411.
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  BackHandler: {
    addEventListener: (_event: string, listener: () => boolean) => {
      back.listeners.push(listener);
      return { remove: () => back.listeners.splice(back.listeners.indexOf(listener), 1) };
    },
  },
}));
vi.mock("react-native-reanimated", () => ({
  default: { View: "Animated.View" },
  Easing: { out: (easing: unknown) => easing, ease: "ease" },
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: (style: () => object) => style(),
  withRepeat: (animation: unknown) => animation,
  withTiming: (value: number) => value,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: "SafeAreaView",
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));
vi.mock("lucide-react-native", () => ({ ChevronLeft: "ChevronLeft", RefreshCw: "RefreshCw" }));
vi.mock("../src/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}(${Object.values(values).join(",")})` : key),
  }),
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    mascotSource: { uri: "mascot" },
    accentTextHex: "#121421",
    font: { family: { sans: "Inter", display: "SpaceGrotesk" } },
    colors: {
      bg: "#121421",
      surface: "#242638",
      border: "#44475a",
      text: "#dbdff0",
      textMuted: "#b6bace",
      textDim: "#9ca0b1",
      accent: "#40dd8f",
      accentSoft: "#19322f",
      danger: "#e00",
    },
  }),
}));
vi.mock("../src/logger", () => ({ scopeLogger: () => ({ info: (...args: unknown[]) => console.info("[pair-sign-in] log", ...args) }) }));
vi.mock("../src/components/mobile-auth-form", () => ({ MobileAuthButton: "MobileAuthButton" }));
vi.mock("../src/components/mobile-app-backdrop", () => ({ default: "MobileAppBackdrop" }));
// `createElement` is the static import above: the factory runs when pair-sign-in imports the sheet, after React loads.
vi.mock("../src/components/mobile-bottom-sheet", () => ({
  MobileBottomSheet: ({ visible, children, testID }: { visible: boolean; children: ReactNode; testID?: string }) =>
    visible ? createElement("MobileBottomSheet", { testID }, children) : null,
  useMobileSheetClose: () => sheet.close,
}));
vi.mock("../src/pairing-qr", () => ({ QrCode: "QrCode" }));
vi.mock("../src/pairing-hook", () => ({ usePairing: () => ({ state: { phase: "idle" }, restart: () => undefined }) }));

import { MobilePairSignInView } from "../src/pair-sign-in";
import { codeTileSize } from "../src/short-code";
import type { PairingState } from "../src/pairing/controller";

const NOW = 1_000_000;
const LIFETIME = 5 * 60_000;
const waiting: PairingState = {
  phase: "waiting",
  request: { qrPayload: "spacefleet-pair:abc", shortCode: "K7M4QXR2" } as never,
  expiresAtMs: NOW + 4 * 60_000,
  renewals: 0,
};

const textOf = (node: ReactTestInstance) => node.children.filter((child) => typeof child === "string").join("");
const byId = (tree: ReactTestRenderer, testID: string) => tree.root.findAll((n) => n.props.testID === testID && typeof n.type === "string");
// The mocks render host elements named by string; the renderer types `type` as a component, hence the widening.
const is = (name: string) => (n: ReactTestInstance) => (n.type as unknown) === name;

beforeAll(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

beforeEach(() => {
  back.listeners.length = 0;
});

const mount = async (state: PairingState, app: "badger" | "parrot" = "badger") => {
  const onBack = vi.fn();
  const restart = vi.fn();
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <MobilePairSignInView
        app={app}
        state={state}
        restart={restart}
        now={NOW}
        lifetimeMs={LIFETIME}
        deviceName={`${app === "badger" ? "Badger" : "Parrot"} (Pixel 8)`}
        onBack={onBack}
      />,
    );
  });
  const texts = () => tree.root.findAll(is("Text")).map(textOf).filter(Boolean);
  return { tree, texts, onBack, restart };
};

describe("MobilePairSignIn", () => {
  it("[pair-sign-in-1] shows the mockup's page while a code waits: mascot, live QR, code in 4+4, pulsing dot, real countdown", async () => {
    const { tree, texts } = await mount(waiting);
    console.info("[pair-sign-in-1] texts", texts());
    expect(texts()).toEqual([
      "setup.back",
      "login.pairing.title",
      "phonePairing.signIn.subtitle",
      "PHONEPAIRING.SIGNIN.ORTYPECODE",
      ..."K7M4QXR2".split(""),
      "phonePairing.signIn.waiting",
      "phonePairing.signIn.newCodeIn(4:00)",
      "?",
      "phonePairing.signIn.help",
    ]);
    expect(tree.root.find(is("Image")).props.source).toEqual({ uri: "mascot" });
    expect(tree.root.find(is("QrCode")).props).toMatchObject({ payload: "spacefleet-pair:abc", size: 196 });
    const groups = byId(tree, "pair-sign-in-code")[0]!.children as ReactTestInstance[];
    expect(groups.map((group) => group.findAll(is("Text")).map(textOf).join(""))).toEqual(["K7M4", "QXR2"]);
    expect(byId(tree, "pair-sign-in-dot")).toHaveLength(1);
    // 4:00 left of a 5:00 code: the bar is 80% full, in the app's accent.
    expect(byId(tree, "pair-sign-in-bar")[0]!.props.style).toContainEqual({ backgroundColor: "#40dd8f", width: "80%" });
    // The help sheet stays closed until asked.
    expect(tree.root.findAll(is("MobileBottomSheet"))).toHaveLength(0);
  });

  // @bugfix @regression-proof op9 2026-11-18: the API's code has 8 characters; an older API sent "7RYR-EBTW", whose dash
  // drew a box of its own, and the 44pt boxes ran off both edges of the phone. Chris 2026-11-18: no dash anywhere.
  it("[pair-sign-in-1b] shows the API's 8-character code as 4+4 boxes that fit the phone, with no dash", async () => {
    const { tree } = await mount({ ...waiting, request: { qrPayload: "spacefleet-pair:abc", shortCode: "7RYR-EBTW" } as never });
    const code = byId(tree, "pair-sign-in-code")[0]!;
    const groups = code.children as ReactTestInstance[];
    expect(groups.map((group) => group.findAll(is("Text")).map(textOf).join(""))).toEqual(["7RYR", "EBTW"]);
    expect(code.props.accessibilityLabel).toBe("7 R Y R E B T W");
    // 8 boxes, 6 gaps of 6 and one of 14 between the 28pt margins of a 390pt phone: 35pt boxes.
    const box = groups[0]!.children[0] as ReactTestInstance;
    expect(box.props.style).toContainEqual(expect.objectContaining({ width: 35, height: 46 }));
    for (const width of [360, 390, 411, 430]) {
      const tile = codeTileSize(width, 8);
      expect(8 * tile.width + 6 * 6 + 14).toBeLessThanOrEqual(width - 2 * 28);
    }
    // The mockup's six characters keep its 44x58 boxes.
    expect(codeTileSize(390, 6)).toEqual({ width: 44, height: 58, fontSize: 32 });
  });

  /**
   * @test-id PAIR-SIGN-IN-CHECK-001
   * @req PRIV-PAIR-01
   * @why Chris 2026-11-23 ("yes that'd be better"): once the approving app connected, the phone shows the six digits
   *   to compare with it, under the code, in every language; before that, nothing extra.
   */
  it("[pair-sign-in-check] shows the check code under the code once the approving app connected", async () => {
    const before = await mount(waiting);
    expect(byId(before.tree, "pair-sign-in-check-code")).toHaveLength(0);
    const { tree, texts } = await mount({ ...waiting, checkCode: "067383" });
    console.info("[pair-sign-in-check] texts", texts());
    expect(textOf(byId(tree, "pair-sign-in-check-code")[0]!)).toBe("067 383");
    expect(texts()).toEqual(expect.arrayContaining(["phonePairing.check.label", "phonePairing.check.hint"]));
    const root = resolve(__dirname, "..");
    for (const lang of ["en", "fr", "de", "es", "nl"]) {
      const strings = JSON.parse(readFileSync(resolve(root, `src/i18n/${lang}.json`), "utf8")) as { phonePairing: { check: Record<string, string> } };
      expect(strings.phonePairing.check.label, lang).toBeTruthy();
      expect(strings.phonePairing.check.hint, lang).toBeTruthy();
    }
  });

  // @bugfix @regression-proof Chris 2026-11-18: the approved page has no password link; Back returns to the form.
  it("[pair-sign-in-2] has no 'Sign in with email and password' link: Back and Android's Back return to the form", async () => {
    const { tree, texts, onBack } = await mount(waiting, "parrot");
    expect(texts()).not.toContain("login.pairing.usePassword");
    expect(byId(tree, "pair-sign-in-password")).toHaveLength(0);
    await act(async () => byId(tree, "pair-sign-in-back")[0]!.props.onPress());
    expect(onBack).toHaveBeenCalledTimes(1);
    await act(async () => {
      expect(back.listeners.at(-1)?.()).toBe(true);
    });
    expect(onBack).toHaveBeenCalledTimes(2);
    await act(async () => tree.unmount());
    expect(back.listeners).toHaveLength(0);
  });

  it("[pair-sign-in-3] 'How does this work?' opens the shared sheet with the app's steps, this phone's name and the code's lifetime", async () => {
    for (const app of ["badger", "parrot"] as const) {
      sheet.close.mockClear();
      const { tree } = await mount(waiting, app);
      await act(async () => byId(tree, "pair-sign-in-help")[0]!.props.onPress());
      const opened = tree.root.find(is("MobileBottomSheet"));
      const lines = opened.findAll(is("Text")).map(textOf).filter(Boolean);
      console.info(`[pair-sign-in-3] ${app} sheet`, lines);
      const name = app === "badger" ? "Badger" : "Parrot";
      expect(lines).toEqual([
        "phonePairing.signIn.help",
        "1",
        `phonePairing.signIn.step1.${app}`,
        "2",
        "phonePairing.signIn.step2",
        "3",
        "phonePairing.signIn.step3",
        // The phone's name is glued with no-break spaces so it never splits from its quotes.
        `phonePairing.signIn.deviceName(${name}\u00A0(Pixel\u00A08)) phonePairing.signIn.renews(5)`,
        "phonePairing.signIn.gotIt",
      ]);
      await act(async () => byId(tree, "pair-sign-in-help-ok")[0]!.props.onPress());
      expect(sheet.close).toHaveBeenCalledOnce();
      await act(async () => tree.unmount());
    }
  });

  it("[pair-sign-in-4] says it is getting a code, then signing in, without a countdown", async () => {
    const starting = await mount({ phase: "starting" });
    expect(starting.texts()).toContain("phonePairing.starting");
    expect(byId(starting.tree, "pair-sign-in-expiry")).toHaveLength(0);
    expect(starting.tree.root.findAll(is("ActivityIndicator"))).toHaveLength(1);
    await act(async () => starting.tree.unmount());
    const completing = await mount({ phase: "completing" } as PairingState);
    expect(completing.texts()).toContain("phonePairing.completing");
    expect(byId(completing.tree, "pair-sign-in-expiry")).toHaveLength(0);
    await act(async () => completing.tree.unmount());
  });

  it("[pair-sign-in-5] shows a refusal or a failure with 'Get a new code'", async () => {
    const denied = await mount({ phase: "denied" });
    expect(textOf(byId(denied.tree, "pair-sign-in-error")[0]!)).toBe("phonePairing.denied");
    const retry = denied.tree.root.find(is("MobileAuthButton"));
    expect(retry.props.label).toBe("phonePairing.tryAgain");
    await act(async () => retry.props.onPress());
    expect(denied.restart).toHaveBeenCalledOnce();
    await act(async () => denied.tree.unmount());
    const limited = await mount({ phase: "error", reason: "rate_limited", retryAfterMinutes: 3 });
    expect(textOf(byId(limited.tree, "pair-sign-in-error")[0]!)).toBe("login.errors.tooManyAttempts(3,3)");
    await act(async () => limited.tree.unmount());
  });

  // @bugfix @regression-proof Chris 2026-11-18: "On mobile, Parrot's and Badger's sign in with another device screen
  // is different, but it should be the same shared resource."
  it("[pair-sign-in-shared-1] both phones show this one page, with no page or pairing loop of their own", () => {
    const root = resolve(__dirname, "../../..");
    for (const [file, app] of [
      ["apps/badger/mobile/src/screens/PairSignInScreen.tsx", "badger"],
      ["apps/parrot/mobile/src/screens/LoginScreen.tsx", "parrot"],
    ] as const) {
      const source = readFileSync(resolve(root, file), "utf8");
      const use = source.match(/<MobilePairSignIn\b[\s\S]*?\/>/)?.[0] ?? "";
      console.info("[pair-sign-in-shared-1]", file, use.length > 0 ? "uses MobilePairSignIn" : "no MobilePairSignIn");
      expect(source, file).toContain('import { MobilePairSignIn } from "@space/mobile-shell/pair-sign-in"');
      expect(use, file).toContain(`app="${app}"`);
      expect(use, file).toContain("onBack=");
    }
    for (const file of [
      "apps/badger/mobile/src/screens/LoginScreen.tsx",
      "apps/badger/mobile/src/screens/PairSignInScreen.tsx",
      "apps/parrot/mobile/src/screens/LoginScreen.tsx",
    ]) {
      const source = readFileSync(resolve(root, file), "utf8");
      for (const own of [/usePairing\(/, /<QrCode\b/, /<MobilePairingPanel\b/]) expect(source, `${file} ${own}`).not.toMatch(own);
    }
  });

  it("[pair-sign-in-strings] has the page's text in every language; Parrot's step 1 is Badger's minus the TV", () => {
    const root = resolve(__dirname, "..");
    const tvWord: Record<string, RegExp> = { en: /\bTV\b/, fr: /télévision/, de: /Fernseher/, es: /\bTV\b/, nl: /\btv\b/ };
    const keys = ["subtitle", "orTypeCode", "waiting", "newCodeIn", "help", "step2", "step3", "deviceName", "renews_one", "renews_other", "gotIt"];
    for (const lang of ["en", "fr", "de", "es", "nl"]) {
      const strings = JSON.parse(readFileSync(resolve(root, `src/i18n/${lang}.json`), "utf8")) as {
        login: { pairing: Record<string, string> };
        phonePairing: { signIn: Record<string, string> & { step1: { badger: string; parrot: string } } };
      };
      const page = strings.phonePairing.signIn;
      for (const key of keys) expect(page[key], `${lang} ${key}`).toBeTruthy();
      expect(page.newCodeIn, lang).toContain("{{time}}");
      expect(page.deviceName, lang).toContain("{{name}}");
      expect(strings.login.pairing.usePassword, lang).toBeUndefined();
      const { badger, parrot } = page.step1;
      expect(badger, lang).toMatch(tvWord[lang]!);
      expect(parrot, lang).not.toMatch(tvWord[lang]!);
      expect(badger.startsWith(parrot.slice(0, -1)), lang).toBe(true);
    }
    const fr = JSON.parse(readFileSync(resolve(root, "src/i18n/fr.json"), "utf8")) as { phonePairing: { signIn: Record<string, string | object> } };
    expect(fr.phonePairing.signIn.subtitle).toBe("Scannez ce code avec Badger ou Parrot sur un appareil connecté.");
    // French typography (Main 2026-11-18): a narrow no-break space inside « » and before ? : ; ! so the mark never ends a line alone.
    for (const [key, text] of Object.entries(fr.phonePairing.signIn)) {
      if (typeof text !== "string") continue;
      expect(text, key).not.toMatch(/[«] | [»?:;!]/);
    }
    expect(fr.phonePairing.signIn.help).toBe("Comment ça marche\u202F?");
    expect(fr.phonePairing.signIn.deviceName).toContain("«\u202F{{name}}\u202F»");
  });
});
