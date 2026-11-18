// @req UX-TV-03[badger-mobile]
// UX-TV-03: casting is no longer marked as a beta (Chris 2026-11-13). The Play button's picker shows its title, the
// phone row and the Cast device rows, with no "Beta" badge and no beta note under the list, in every app language.
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18next, { type Resource } from "i18next";
import { CastPickerSheet } from "../src/components/CastPickerSheet";
import type { PickerSheet } from "../src/components/usePickerSheet";

const TAG = "[cast-picker-no-beta]";
const LANGS = ["en", "fr", "de", "es", "nl"] as const;

vi.mock("@space/mobile-mpv-playback", () => ({
  AirPlayPlayer: { getRoute: async () => null },
  AirPlayRoutePickerView: null,
}));
vi.mock("lucide-react-native", () => ({ Smartphone: () => null, Cast: () => null }));
// The real sheet adds the slide, the drags and the crash boundary; this stand-in shows what it holds while open.
vi.mock("../src/components/BottomSheet", async () => {
  const React = await import("react");
  return {
    BottomSheet: ({ sheet, children }: { sheet: { visible: boolean }; children: React.ReactNode }) =>
      sheet.visible ? React.createElement("BottomSheet", null, children) : null,
  };
});
// vi.mock factories are hoisted above every import, so the factory loads the dictionaries itself.
vi.mock("@space/mobile-shell/i18n", async () => {
  const resources: Resource = {};
  for (const lng of ["en", "fr", "de", "es", "nl"]) {
    resources[lng] = { translation: (await import(`../../../../packages/mobile-shell/src/i18n/${lng}.json`)).default };
  }
  await i18next.init({ resources, lng: "en", fallbackLng: "en", interpolation: { escapeValue: false } });
  const translate = (key: string, options?: Record<string, unknown>) => i18next.t(key, options);
  return { translate, getCurrentLanguage: () => i18next.language, useTranslation: () => ({ t: translate }) };
});

const openSheet: PickerSheet = {
  visible: true,
  open: () => undefined,
  close: (after) => after?.(),
  closed: () => undefined,
};

/** Every string the rendered tree shows, plus every accessibility label (a badge can live in either). */
const shownText = (tree: ReactTestRenderer): string[] => {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (typeof node === "string") return void out.push(node);
    if (Array.isArray(node)) return node.forEach(walk);
    const el = node as { props?: Record<string, unknown>; children?: unknown };
    const label = el.props?.accessibilityLabel;
    if (typeof label === "string") out.push(label);
    walk(el.children);
  };
  walk(tree.toJSON());
  return out;
};

let tree: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
});

describe("cast picker without the beta marker (UX-TV-03)", () => {
  for (const lng of LANGS) {
    it(`shows no Beta badge and no beta note in ${lng}`, async () => {
      await i18next.changeLanguage(lng);
      await act(async () => {
        tree = create(
          React.createElement(CastPickerSheet, {
            sheet: openSheet,
            devices: [{ deviceId: "salon", friendlyName: "Salon", modelName: "Chromecast with Google TV" }],
            onPhone: () => undefined,
            onTarget: () => undefined,
          }),
        );
      });
      const text = shownText(tree!);
      console.info(TAG, lng, "shown:", text);
      expect(text).toContain(i18next.t("cast.pickerTitle"));
      expect(text).toContain(i18next.t("cast.thisPhone"));
      expect(text.some((s) => s.includes("Salon"))).toBe(true);
      expect(text.filter((s) => /b[eêè]ta/i.test(s))).toEqual([]);
      expect(i18next.exists("cast.beta")).toBe(false);
      expect(i18next.exists("cast.betaNote")).toBe(false);
    });
  }
});
