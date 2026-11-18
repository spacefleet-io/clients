/**
 * @test-id MOBILE-SHELL-CREDITS-001
 * @level unit
 * @why Chris 2026-11-11: "The about section in all apps should be a collapsable menu that is closed by default, on all
 *   apps". On the phone and TV the credits sit under one "About" header row, closed by default; a tap (or the remote's
 *   select, which presses the focused row) opens it in place, and the attribution inside (sources, a source's logo and
 *   notice) is unchanged. META-SRC-09: the list comes from the metadata service, kept on the device, with a neutral
 *   line before the app was ever online.
 */
// @req UX-SET-02[badger-mobile] @req UX-SET-02[badger-tv] @req UX-SET-02[parrot]
// @req META-SRC-09[badger-mobile,badger-tv,parrot]
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { creditsFor } from "@space/legal/credits";
import type { CreditsSource, SourceCredits } from "@space/metadata-client/credits";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Image: "Image",
  Linking: { openURL: () => Promise.resolve() },
  Pressable: "Pressable",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("react-native-svg", () => ({ SvgXml: "SvgXml" }));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ colors: { text: "#fff", textMuted: "#aaa", accent: "#ffb357" }, font: { family: { sans: "Inter" } } }),
}));

import { MobileCreditsPanel } from "../src/components/mobile-credits-panel";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 5"></svg>';

const answer: SourceCredits = {
  product: "badger",
  language: "de",
  separator: ": ",
  entries: [
    { id: "example", name: "Example Source", url: "https://example.org", text: "Titel.", licence: null, licenceUrl: null, logo: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`, notice: "Example notice." },
    { id: "other", name: "Other Source", url: "https://other.example", text: "Marker.", licence: null, licenceUrl: null, logo: null, notice: null },
  ],
};

const byTestId = (renderer: ReactTestRenderer, testID: string) =>
  renderer.root.findAll((node: { props: { testID?: string }; type: unknown }) => node.props.testID === testID && typeof node.type === "string");

const mount = async (element: React.ReactElement) => {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(element);
  });
  return renderer;
};

describe("MobileCreditsPanel", () => {
  it.each(["badger", "parrot"] as const)("is a closed About row that opens in place on the service's list (%s)", async (product) => {
    const source: CreditsSource = { load: async () => answer, store: null };
    const renderer = await mount(<MobileCreditsPanel language="de" product={product} source={source} openLinks={false} />);
    const [toggle] = byTestId(renderer, "settings-credits-toggle");
    console.info(`[MOBILE-SHELL-CREDITS-001] ${product} closed: body=${byTestId(renderer, "settings-credits-body").length}`);
    expect(toggle?.props.accessibilityLabel).toBe(creditsFor("de").about);
    expect(toggle?.props.accessibilityState).toEqual({ expanded: false });
    expect(byTestId(renderer, "settings-credits-body")).toHaveLength(0);

    act(() => toggle?.props.onPress());
    console.info(`[MOBILE-SHELL-CREDITS-001] ${product} opened: body=${byTestId(renderer, "settings-credits-body").length}`);
    expect(byTestId(renderer, "settings-credits-toggle")[0]?.props.accessibilityState).toEqual({ expanded: true });
    expect(byTestId(renderer, "credit-example")).toHaveLength(1);
    expect(byTestId(renderer, "credit-other")).toHaveLength(1);
    const [logo] = byTestId(renderer, "credit-logo");
    expect(logo?.props.xml).toBe(SVG);
    expect(logo?.props.width).toBe(96);

    act(() => byTestId(renderer, "settings-credits-toggle")[0]?.props.onPress());
    expect(byTestId(renderer, "settings-credits-body")).toHaveLength(0);
  });

  it("shows a neutral line before the app was ever online", async () => {
    const source: CreditsSource = {
      load: async () => {
        throw new Error("offline");
      },
      store: { getItem: () => null, setItem: () => undefined },
    };
    const renderer = await mount(<MobileCreditsPanel language="fr" product="parrot" source={source} openLinks />);
    act(() => byTestId(renderer, "settings-credits-toggle")[0]?.props.onPress());
    const [line] = byTestId(renderer, "settings-credits-unavailable");
    console.info(`[MOBILE-SHELL-CREDITS-001] offline: ${line?.props.children}`);
    expect(line?.props.children).toBe(creditsFor("fr").unavailable);
  });

  it("rings the About row when the TV remote focuses it", async () => {
    const renderer = await mount(<MobileCreditsPanel language="en" product="badger" source={{ load: null, store: null }} openLinks={false} scale={1.5} />);
    const borderColor = () => (byTestId(renderer, "settings-credits-toggle")[0]?.props.style as { borderColor?: string }[])[1]?.borderColor;
    expect(borderColor()).toBe("transparent");
    act(() => byTestId(renderer, "settings-credits-toggle")[0]?.props.onFocus());
    expect(borderColor()).toBe("#ffb357");
  });
});
