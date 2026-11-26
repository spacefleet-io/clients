/**
 * UX-NOTICE-08: the phone and TV apps (Badger, Parrot: the one shared sign) show the unpaid state as a small floating
 * sign, never a strip: on the phone's tab bar edge (where the offline sign sits) or at the bottom of other screens, and
 * under the TV's top bar. One word on screen, the whole notice (playback and uploads stopped, the wipe date,
 * ACCT-UNPAID-03) as its spoken label, and nothing for paid or free accounts.
 * ACCT-PAY-02: the sign only informs, with nothing to press and no payment wording.
 *
 * Renders the real `UnpaidAccessSign` with react-test-renderer; React Native host components are plain strings.
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18next from "i18next";
import type { AccountAccess } from "@space/shared/accountAccess";
import { changeLanguage } from "../src/i18n";
import { UnpaidAccessSign, UnpaidScreenLayout } from "../src/components/mobile-unpaid-access-sign";
import { TV_SAFE_MARGIN_Y } from "../src/tv/layout";

const SUITE = "mobile-shell-test:unpaid-access-sign";
const NAV_BAR = 24;

vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: "View",
  Text: "Text",
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 32, right: 0, bottom: 24, left: 0 }) }));
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

type SignProps = { access: AccountAccess | null; tv?: boolean; underBar?: boolean; inline?: boolean; scale?: number };

const mountSign = async (test: string, props: SignProps) => {
  console.info(`[${SUITE}] [${test}] mount`, { state: props.access?.state ?? null, tv: props.tv, underBar: props.underBar, scale: props.scale });
  await act(async () => {
    renderer?.unmount();
    renderer = create(<UnpaidAccessSign {...props} />);
  });
  if (!renderer) throw new Error("UnpaidAccessSign did not mount");
  const root = renderer.root;
  const [layer] = root.findAll((node) => node.props.testID === "unpaid-access-sign-layer" && typeof node.type === "string");
  const [sign] = root.findAll((node) => node.props.testID === "unpaid-access-sign" && typeof node.type === "string");
  console.info(`[${SUITE}] [${test}] rendered`, { layer: layer?.props.style, label: sign?.props.accessibilityLabel, text: sign ? textOf(sign) : null });
  return { tree: renderer, root, layer, sign };
};

/** Every string rendered inside a host component (the stand-in Text), in order. */
const textOf = (root: ReactTestInstance): string =>
  root
    .findAll((node) => typeof node.type === "string")
    .flatMap((node) => node.children.filter((child): child is string => typeof child === "string"))
    .join(" ");

/** The sign's flattened layer style (base sheet + position). */
const layerStyle = (layer: ReactTestInstance | undefined) => Object.assign({}, ...((layer?.props.style ?? []) as object[]));

const actionable = (root: ReactTestInstance) =>
  root.findAll(
    (node) =>
      typeof node.props.onPress === "function" ||
      node.props.href !== undefined ||
      node.props.focusable === true ||
      node.props.accessibilityRole === "link" ||
      node.props.accessibilityRole === "button",
  );

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

describe("the unpaid sign on the phone and TV screens", () => {
  /** @req UX-NOTICE-08[badger-mobile] @req UX-NOTICE-08[parrot] @req ACCT-UNPAID-03[badger-mobile] @req ACCT-UNPAID-03[parrot] */
  it("an unpaid account sees one short word, and hears the wipe date and that playback and uploads are stopped (en)", async () => {
    const { sign } = await mountSign("phone-en", { access: UNPAID });
    expect(sign).toBeDefined();
    expect(textOf(sign!)).toBe("Plan ended");
    expect(sign?.props.accessibilityLabel).toBe("Your subscription ended. Playback and uploads are stopped. Your files are deleted on December 16, 2099.");
  });

  /** @req UX-NOTICE-08[badger-mobile] @req UX-NOTICE-08[parrot] @req ACCT-UNPAID-03[badger-mobile] @req ACCT-UNPAID-03[parrot] */
  it("the same in French", async () => {
    await changeLanguage("fr");
    const { sign } = await mountSign("phone-fr", { access: UNPAID });
    expect(textOf(sign!)).toBe("Abonnement terminé");
    expect(sign?.props.accessibilityLabel).toBe("Votre abonnement est terminé. La lecture et les envois sont arrêtés. Vos fichiers seront supprimés le 16 décembre 2099.");
  });

  /** @req UX-NOTICE-08[badger-mobile] @req UX-NOTICE-08[parrot] */
  it("on a phone screen pushed over the tabs the sign floats at the bottom, above the navigation bar, clear of the screen's title, and lets touches through", async () => {
    const { layer, sign } = await mountSign("phone-float", { access: UNPAID });
    expect(layer?.props.pointerEvents).toBe("none");
    expect(sign?.props.pointerEvents).toBe("none");
    const style = layerStyle(layer);
    expect(style).toMatchObject({ position: "absolute", left: 0, right: 0, bottom: NAV_BAR + 6, alignItems: "center" });
    expect(style.top).toBeUndefined();
  });

  /** @req UX-NOTICE-08[badger-mobile] @req UX-NOTICE-08[parrot] */
  it("for the phone's tab bar the sign is the bare pill, placed by the bar's badge slot like the offline sign", async () => {
    const { layer, sign } = await mountSign("phone-inline", { access: UNPAID, inline: true });
    expect(layer).toBeUndefined();
    expect(sign?.props.pointerEvents).toBe("none");
    expect(textOf(sign!)).toBe("Plan ended");
  });

  /** @req ACCT-UNPAID-05[badger-mobile] @req ACCT-UNPAID-05[parrot] @req UX-NOTICE-08[badger-tv] */
  it("the screen layout floats the sign on pushed screens, leaves it to the tab bar on the phone's tab pages, and keeps it on the TV's", async () => {
    const signsIn = async (test: string, props: Partial<React.ComponentProps<typeof UnpaidScreenLayout>>) => {
      await act(async () => {
        renderer?.unmount();
        renderer = create(
          <UnpaidScreenLayout access={UNPAID} {...props}>
            {null}
          </UnpaidScreenLayout>,
        );
      });
      const count = renderer!.root.findAll((node) => node.props.testID === "unpaid-access-sign-layer" && typeof node.type === "string").length;
      console.info(`[${SUITE}] [${test}] floating signs`, count);
      return count;
    };
    expect(await signsIn("pushed", {})).toBe(1);
    expect(await signsIn("tab-pages", { onTabBar: true })).toBe(0);
    expect(await signsIn("tv-main", { onTabBar: true, tv: true })).toBe(1);
    expect(await signsIn("player", { playing: true })).toBe(0);
  });

  /** @req ACCT-PAY-02[badger-mobile] @req ACCT-PAY-02[badger-tv] @req ACCT-UNPAID-03[parrot] @req ACCT-UNPAID-03[parrot-tv] */
  it("the sign only informs: nothing in it can be pressed, focused or followed, on a phone or a TV", async () => {
    for (const tv of [false, true]) {
      const { root, sign } = await mountSign(`no-action:${tv ? "tv" : "phone"}`, { access: UNPAID, tv });
      expect(actionable(root)).toEqual([]);
      expect(sign?.props.accessibilityRole).toBe("text");
    }
  });

  /** @req UX-NOTICE-08[badger-tv] @req UX-NOTICE-08[parrot-tv] */
  it("on a TV the sign sits under the top bar at the TV's scale (UX-TV-13), or at the safe margin on a page without the bar", async () => {
    const underBar = await mountSign("tv-under-bar", { access: UNPAID, tv: true, scale: 2 });
    expect(layerStyle(underBar.layer)).toMatchObject({ position: "absolute", top: 58 * 2 });
    expect(underBar.sign?.props.style[0]).toMatchObject({ height: 44, borderRadius: 22 });
    const noBar = await mountSign("tv-no-bar", { access: UNPAID, tv: true, underBar: false, scale: 2 });
    expect(layerStyle(noBar.layer)).toMatchObject({ position: "absolute", top: TV_SAFE_MARGIN_Y * 2 });
  });

  /** @req UX-NOTICE-08[badger-mobile] @req UX-NOTICE-08[parrot] */
  it("a paid, free or not yet known account sees no sign", async () => {
    for (const access of [PAID, FREE, null]) {
      const { tree } = await mountSign(`none:${access?.state ?? "unknown"}`, { access });
      expect(tree.toJSON()).toBeNull();
    }
  });
});
