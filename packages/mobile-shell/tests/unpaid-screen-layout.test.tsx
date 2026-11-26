/**
 * ACCT-UNPAID-05: the unpaid sign sits on every screen of a navigator (`UnpaidScreenLayout`, the phone and TV apps'
 * `screenLayout`), not only the tab pages, and stays off the player.
 * UX-NOTICE-08: the sign floats over the screen: the screen keeps the device's safe-area insets and its whole size,
 * so nothing moves when the account becomes unpaid.
 *
 * Renders the real `UnpaidScreenLayout` and `UnpaidAccessSign` with react-test-renderer; React Native host
 * components are plain strings and the safe-area context is a plain React context.
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountAccess } from "@space/shared/accountAccess";

const SUITE = "mobile-shell-test:unpaid-screen-layout";

vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: "View",
  Text: "Text",
}));
vi.mock("react-native-safe-area-context", async () => {
  const ReactActual = await vi.importActual<typeof React>("react");
  const SafeAreaInsetsContext = ReactActual.createContext({ top: 0, right: 0, bottom: 0, left: 0 });
  return { SafeAreaInsetsContext, useSafeAreaInsets: () => ReactActual.useContext(SafeAreaInsetsContext) };
});
vi.mock("../src/i18n", () => ({
  getCurrentLanguage: () => "en",
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => `${key}${options?.date ? `:${String(options.date)}` : ""}` }),
}));
vi.mock("../src/theme", () => {
  const colors = new Proxy({}, { get: () => "#888" });
  return { useMobileShellTheme: () => ({ colors }) };
});
vi.mock("lucide-react-native", () => ({ AlertTriangle: () => null }));

import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { UnpaidScreenLayout } from "../src/components/mobile-unpaid-access-sign";

const UNPAID: AccountAccess = {
  state: "unpaid",
  paidUntil: "2020-01-01T00:00:00.000Z",
  billingPeriod: "monthly",
  wipeAt: "2099-12-16T12:00:00.000Z",
  qosTier: "free",
};
const PAID: AccountAccess = { state: "paid", paidUntil: "2099-01-01T00:00:00.000Z", billingPeriod: "annual", wipeAt: null, qosTier: "paid" };
const DEVICE_INSETS = { top: 32, right: 0, bottom: 24, left: 0 };

/** A pushed screen (a film's page, an album) that pads its own top by the safe-area inset, as the apps' screens do. */
const DetailScreen = () => {
  const insets = useSafeAreaInsets();
  return React.createElement("View", { testID: "detail-screen", insetTop: insets.top, insetBottom: insets.bottom });
};

let renderer: ReactTestRenderer | null = null;

const mount = async (test: string, props: { access: AccountAccess | null; playing?: boolean; tv?: boolean; scale?: number }) => {
  console.info(`[${SUITE}] [${test}] mount`, { state: props.access?.state ?? null, playing: props.playing, tv: props.tv, scale: props.scale });
  await act(async () => {
    renderer = create(
      <SafeAreaInsetsContext.Provider value={DEVICE_INSETS}>
        <UnpaidScreenLayout {...props}>
          <DetailScreen />
        </UnpaidScreenLayout>
      </SafeAreaInsetsContext.Provider>,
    );
  });
  if (!renderer) throw new Error("UnpaidScreenLayout did not mount");
  const root = renderer.root;
  const signs = root.findAll((node) => node.props.testID === "unpaid-access-sign" && typeof node.type === "string");
  const [layer] = root.findAll((node) => node.props.testID === "unpaid-access-sign-layer" && typeof node.type === "string");
  const [screen] = root.findAll((node) => node.props.testID === "detail-screen" && typeof node.type === "string");
  const style = Object.assign({}, ...((layer?.props.style ?? []) as object[]));
  console.info(`[${SUITE}] [${test}] rendered`, {
    signs: signs.length,
    layerStyle: style,
    screenInsets: { top: screen?.props.insetTop, bottom: screen?.props.insetBottom },
  });
  return { root, signs, layer, style, screen };
};

const pressable = (root: ReactTestInstance) =>
  root.findAll(
    (node) =>
      typeof node.props.onPress === "function" ||
      node.props.focusable === true ||
      node.props.accessibilityRole === "link" ||
      node.props.accessibilityRole === "button",
  );

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
});

describe("the unpaid sign on every screen of the navigator (ACCT-UNPAID-05)", () => {
  /** @req ACCT-UNPAID-05[badger-mobile] @req ACCT-UNPAID-05[parrot] @req UX-NOTICE-08[badger-mobile] @req UX-NOTICE-08[parrot] @req ACCT-PAY-02[badger-mobile] */
  it("a pushed screen of an unpaid account shows the sign floating over it, and the screen keeps its insets", async () => {
    const { root, signs, layer, style, screen } = await mount("phone-detail", { access: UNPAID });
    expect(signs).toHaveLength(1);
    expect(layer?.props.pointerEvents).toBe("none");
    // At the bottom, above the navigation bar: the top of a pushed screen holds its title and buttons.
    expect(style).toMatchObject({ position: "absolute", bottom: DEVICE_INSETS.bottom + 6 });
    // Nothing moves: the screen still pads by the device's own insets, as for a paid account.
    expect(screen?.props.insetTop).toBe(DEVICE_INSETS.top);
    expect(screen?.props.insetBottom).toBe(DEVICE_INSETS.bottom);
    expect(pressable(root)).toEqual([]);
  });

  /** @req ACCT-UNPAID-05[badger-mobile] @req ACCT-UNPAID-05[parrot] */
  it("the player shows no sign while a title plays", async () => {
    const { signs, screen } = await mount("player", { access: UNPAID, playing: true });
    expect(signs).toHaveLength(0);
    expect(screen?.props.insetTop).toBe(DEVICE_INSETS.top);
  });

  /** @req ACCT-UNPAID-05[badger-mobile] @req ACCT-UNPAID-05[parrot] */
  it("a paid or not yet known account sees no sign and the same screen", async () => {
    for (const access of [PAID, null]) {
      const { signs, screen } = await mount(`no-sign:${access?.state ?? "unknown"}`, { access });
      expect(signs).toHaveLength(0);
      expect(screen?.props.insetTop).toBe(DEVICE_INSETS.top);
      await act(async () => renderer?.unmount());
    }
  });

  /** @req ACCT-UNPAID-05[badger-tv] @req UX-NOTICE-08[badger-tv] @req ACCT-PAY-02[badger-tv] */
  it("on a TV the sign sits under the top bar at the TV's scale and nothing in it takes the remote's focus", async () => {
    const { root, signs, style } = await mount("tv-detail", { access: UNPAID, tv: true, scale: 2 });
    expect(signs).toHaveLength(1);
    expect(style).toMatchObject({ position: "absolute", top: 58 * 2 });
    expect(pressable(root)).toEqual([]);
  });
});
