/**
 * ACCT-UNPAID-03: above the main screens the phone and TV apps (Badger, Parrot: the one shared notice) show an unpaid
 * notice with the wipe date that says playback and uploads are stopped, and nothing for paid or free accounts.
 * ACCT-PAY-02: the notice only informs, with nothing to press and no payment wording.
 *
 * Renders the real `UnpaidAccessBanner` with react-test-renderer; React Native host components are plain strings.
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import type { AccountAccess } from "@space/shared/accountAccess";
import { changeLanguage } from "../src/i18n";
import { UnpaidAccessBanner } from "../src/components/mobile-unpaid-access-banner";

vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: "View",
  Text: "Text",
}));
// vi.mock factories are hoisted above every import, so this one loads the dictionaries itself.
vi.mock("../src/i18n", async () => {
  const enDict = (await import("../src/i18n/en.json")).default;
  const frDict = (await import("../src/i18n/fr.json")).default;
  await i18next.init({
    resources: { en: { translation: enDict }, fr: { translation: frDict } },
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
  });
  const translate = (key: string, options?: Record<string, unknown>) => i18next.t(key, options);
  return {
    getCurrentLanguage: () => i18next.language,
    changeLanguage: (code: string) => i18next.changeLanguage(code),
    useTranslation: () => ({ t: translate }),
  };
});
vi.mock("../src/components/mobile-sky-cover", () => ({ SkyCover: "SkyCover" }));
vi.mock("../src/theme", () => {
  const colors = new Proxy({}, { get: () => "#888" });
  return { useMobileShellTheme: () => ({ colors }) };
});
vi.mock("lucide-react-native", () => ({ AlertTriangle: () => null }));

const UNPAID: AccountAccess = {
  state: "unpaid",
  paidUntil: "2020-01-01T00:00:00.000Z",
  billingPeriod: "monthly",
  wipeAt: "2099-12-16T12:00:00.000Z",
  qosTier: "free",
};
const PAID: AccountAccess = {
  state: "paid",
  paidUntil: "2099-01-01T00:00:00.000Z",
  billingPeriod: "annual",
  wipeAt: null,
  qosTier: "paid",
};
const FREE: AccountAccess = { state: "free", paidUntil: null, billingPeriod: null, wipeAt: null, qosTier: "free" };

let renderer: ReactTestRenderer | null = null;

const mountBanner = async (access: AccountAccess | null, scale?: number): Promise<ReactTestRenderer> => {
  await act(async () => {
    renderer?.unmount();
    renderer = create(<UnpaidAccessBanner access={access} scale={scale} />);
  });
  if (!renderer) throw new Error("UnpaidAccessBanner did not mount");
  return renderer;
};

/** Every string rendered inside a host component (the stand-in Text), in order. */
const textOf = (root: ReactTestInstance): string =>
  root
    .findAll((node) => typeof node.type === "string")
    .flatMap((node) => node.children.filter((child): child is string => typeof child === "string"))
    .join(" ");

beforeEach(() => {
  // React's act() reads this flag off the global; the global type has no such field.
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(async () => {
    renderer?.unmount();
  });
  renderer = null;
  await changeLanguage("en");
});

describe("unpaid notice above the main screens", () => {
  /** @req ACCT-UNPAID-03[badger-mobile] @req ACCT-UNPAID-03[parrot] */
  it("an unpaid account sees the wipe date and that playback and uploads are stopped (en)", async () => {
    const tree = await mountBanner(UNPAID);
    const banner = tree.root.findAll((node) => node.props.testID === "unpaid-access-banner" && typeof node.type === "string");
    const text = textOf(tree.root);
    console.info("unpaid banner en", text);
    expect(banner).toHaveLength(1);
    expect(banner[0]?.props.accessibilityRole).toBe("alert");
    expect(text).toBe("Your subscription ended. Playback and uploads are stopped. Your files are deleted on December 16, 2099.");
  });

  /** @req ACCT-UNPAID-03[badger-mobile] @req ACCT-UNPAID-03[parrot] */
  it("an unpaid account sees the wipe date and that playback and uploads are stopped (fr)", async () => {
    await changeLanguage("fr");
    const tree = await mountBanner(UNPAID);
    const text = textOf(tree.root);
    console.info("unpaid banner fr", text);
    expect(text).toBe("Votre abonnement est terminé. La lecture et les envois sont arrêtés. Vos fichiers seront supprimés le 16 décembre 2099.");
  });

  /** @req ACCT-UNPAID-03[badger-mobile] @req ACCT-PAY-02[badger-mobile] @req ACCT-UNPAID-03[parrot] */
  it("the notice only informs: nothing in it can be pressed or followed", async () => {
    const tree = await mountBanner(UNPAID);
    const actionable = tree.root.findAll(
      (node) => typeof node.props.onPress === "function" || node.props.href !== undefined || node.props.accessibilityRole === "link" || node.props.accessibilityRole === "button",
    );
    expect(actionable).toEqual([]);
  });

  /** @req ACCT-UNPAID-03[parrot-tv] */
  it("on a TV the same notice, sized by the TV's scale (UX-TV-13), says the same and has nothing to press", async () => {
    const tree = await mountBanner(UNPAID, 2);
    const [banner] = tree.root.findAll((node) => node.props.testID === "unpaid-access-banner" && typeof node.type === "string");
    expect(banner?.props.style[0]).toMatchObject({ borderRadius: 28, paddingHorizontal: 28 });
    expect(textOf(tree.root)).toBe("Your subscription ended. Playback and uploads are stopped. Your files are deleted on December 16, 2099.");
    expect(tree.root.findAll((node) => typeof node.props.onPress === "function" || node.props.focusable === true)).toEqual([]);
  });

  /** @req ACCT-UNPAID-03[badger-mobile] @req ACCT-UNPAID-03[parrot] */
  it("a paid, free or not yet known account sees no notice", async () => {
    for (const access of [PAID, FREE, null]) {
      const tree = await mountBanner(access);
      expect(tree.toJSON()).toBeNull();
    }
  });
});
