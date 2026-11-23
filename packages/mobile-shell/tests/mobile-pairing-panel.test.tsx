/**
 * @test-id MOBILE-SHELL-PAIRING-PANEL-001
 * @level unit
 * @req ACCT-PAIR-01[badger-mobile,parrot]
 * @why The key screens of Badger's and Parrot's phones show the same pairing panel. It is one shared component with
 *   one look: each phase (getting a code, showing it, signing in, refused, failed) must show the right lines, and both
 *   apps must use it instead of their own copy. The sign-in page is tested in mobile-pair-sign-in.test.tsx.
 */
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Platform: { OS: "android" }, View: "View", Text: "Text", StyleSheet: { create: <T,>(styles: T) => styles } }));
vi.mock("../src/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) => (values ? `${key}(${Object.values(values).join(",")})` : key),
  }),
}));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ colors: { text: "#fff", textMuted: "#999", danger: "#e00", accent: "#ffb357" } }),
}));
vi.mock("../src/components/mobile-auth-form", () => ({ MobileAuthButton: "MobileAuthButton" }));
vi.mock("../src/pairing-qr", () => ({ QrCode: "QrCode" }));
vi.mock("../src/pairing-hook", () => ({ usePairing: () => ({ state: { phase: "idle" }, restart: () => undefined }) }));

import { MobilePairingButton as Button, MobilePairingPanelView, MobilePairingText as Text } from "../src/pairing-panel";
import { ShortCodeTiles } from "../src/short-code";
import type { PairingState } from "../src/pairing/controller";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

const all = (node: unknown, out: Element[] = []): Element[] => {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) all(child, out);
    return out;
  }
  const element = node as Element;
  out.push(element);
  all(element.props?.children, out);
  return out;
};

const render = (state: PairingState, restart = () => undefined, app: "badger" | "parrot" = "badger", purpose?: "key") => {
  const tree = MobilePairingPanelView({ state, app, purpose, restart, now: 1_000, deviceName: "Pixel 8", testIDPrefix: "pair" });
  const elements = all(tree);
  const lines = elements.filter((e) => e.type === Text).map((e) => ({ tone: e.props.tone, text: e.props.children, testID: e.props.testID }));
  return { elements, lines };
};

describe("MobilePairingPanel", () => {
  it("shows the QR code, short code, expiry and device name while a code waits", () => {
    const { elements, lines } = render({
      phase: "waiting",
      request: { qrPayload: "spacefleet-pair:abc", shortCode: "K7M4QXR2" } as never,
      expiresAtMs: 1_000 + 125_000,
      renewals: 0,
    });
    const qr = elements.find((e) => e.type === "QrCode");
    expect(qr?.props).toMatchObject({ payload: "spacefleet-pair:abc", size: 200, label: "phonePairing.qrAccessibility" });
    expect(elements.find((e) => e.props.testID === "pair-qr")).toBeDefined();
    expect(lines.map((l) => l.text)).toEqual([
      "phonePairing.step1.badger",
      "phonePairing.step2",
      "phonePairing.step3",
      "phonePairing.codeLabel",
      "phonePairing.expiresIn(2:05)",
      "phonePairing.deviceName(Pixel 8)",
    ]);
    // ACCT-PAIR-01: the code in the shared 4+4 boxes, never a dash (Chris 2026-11-18).
    expect(elements.find((e) => e.type === ShortCodeTiles)?.props).toMatchObject({ code: "K7M4QXR2", testID: "pair-code" });
    expect(elements.some((e) => e.type === Button)).toBe(false);
  });

  it("says it is getting a code, then signing in", () => {
    expect(render({ phase: "starting" }).lines.at(-1)?.text).toBe("phonePairing.starting");
    expect(render({ phase: "completing" }).lines.at(-1)?.text).toBe("phonePairing.completing");
  });

  it("shows the refusal or the failure as an error with a button for a new code", () => {
    const restart = vi.fn();
    const denied = render({ phase: "denied" }, restart);
    expect(denied.lines.at(-1)).toMatchObject({ tone: "error", text: "phonePairing.denied" });
    const button = denied.elements.find((e) => e.type === Button);
    expect(button?.props.label).toBe("phonePairing.tryAgain");
    (button?.props.onPress as () => void)();
    expect(restart).toHaveBeenCalledOnce();
    expect(render({ phase: "error", reason: "unreachable" }).lines.at(-1)).toMatchObject({ tone: "error", text: "phonePairing.errors.unreachable" });
  });

  // @req ACCT-AUTH-11
  it("[pair-panel-429] says when to try again with the API's wait, using the shared sign-in sentence", () => {
    const limited = render({ phase: "error", reason: "rate_limited", retryAfterMinutes: 3 });
    console.info("[pair-panel-429] lines", JSON.stringify(limited.lines));
    expect(limited.lines.at(-1)).toMatchObject({ tone: "error", text: "login.errors.tooManyAttempts(3,3)" });
    expect(limited.elements.find((e) => e.type === Button)?.props.label).toBe("phonePairing.tryAgain");
    expect(render({ phase: "error", reason: "rate_limited" }).lines.at(-1)?.text).toBe("login.errors.tooManyAttempts(15,15)");
  });

  // @req ACCT-PAIR-01
  it("[key-pair-panel-1] says it opens the library, not signs in, when it only brings the key", () => {
    expect(render({ phase: "completing" }, () => undefined, "parrot", "key").lines.at(-1)?.text).toBe("phonePairing.completingKey");
  });

  // @req ACCT-PAIR-01 @req PLAT-KEYDEV-01
  it("[key-pair-panel-2] every phone and TV key screen offers 'Get the key from another device' with this panel", () => {
    const root = resolve(__dirname, "../../..");
    const read = (file: string) => readFileSync(resolve(root, file), "utf8");
    // Every phone and TV key screen is the shared step (Badger phone and TV, Parrot's setup step and its later key
    // screen); it shows the card, and each app hands it its own panel.
    expect(read("packages/mobile-shell/src/components/mobile-library-key-step.tsx")).toContain('t("phonePairing.keyLink")');
    expect(read("apps/badger/mobile/src/screens/OnboardingKeyScreen.tsx")).toContain("renderOtherDevice=");
    expect(read("apps/badger/mobile/src/screens/KeyFromAnotherDevice.tsx")).toContain('purpose="key"');
    expect(read("apps/parrot/mobile/src/screens/LibraryKeyScreen.tsx")).toContain("renderOtherDevice=");
    expect(read("apps/parrot/mobile/src/screens/PairingPanel.tsx")).toContain('purpose="key"');
    for (const language of ["en", "fr", "de", "nl", "es"]) {
      const strings = JSON.parse(read(`packages/mobile-shell/src/i18n/${language}.json`)) as { phonePairing: Record<string, string> };
      for (const key of ["keyLink", "keyCard", "keyTitle", "typeKey", "completingKey"]) expect(strings.phonePairing[key], `${language} ${key}`).toBeTruthy();
    }
  });

  // @req UX-PHONE-05
  it("names the TV as an approver on Badger only, in every language, from one set of strings", () => {
    const parrot = render({ phase: "idle" }, () => undefined, "parrot");
    console.info("[pair-panel-app] parrot lines", parrot.lines.map((l) => l.text));
    expect(parrot.lines[0]?.text).toBe("phonePairing.step1.parrot");
    const root = resolve(__dirname, "..");
    const tvWord: Record<string, RegExp> = { en: /\bTV\b/, fr: /télévision/, de: /Fernseher/, es: /\bTV\b/, nl: /\btv\b/ };
    for (const lang of ["en", "fr", "de", "es", "nl"]) {
      const strings = JSON.parse(readFileSync(resolve(root, `src/i18n/${lang}.json`), "utf8")) as {
        phonePairing: { step1: { badger: string; parrot: string } };
      };
      const { badger, parrot: parrotText } = strings.phonePairing.step1;
      console.info(`[pair-panel-app] ${lang}`, { badger, parrot: parrotText });
      expect(badger).toMatch(/Badger/);
      expect(badger).toMatch(/Parrot/);
      expect(badger).toMatch(tvWord[lang]);
      expect(parrotText).toMatch(/Parrot/);
      expect(parrotText).not.toMatch(tvWord[lang]);
      expect(badger.startsWith(parrotText.slice(0, -1)), lang).toBe(true);
    }
  });
});
