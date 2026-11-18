/**
 * @test-id MOBILE-SHELL-OSS-001
 * @level unit
 * @why Chris 2026-11-12 (chat): "the link should also go into the app's opensource section". On the phones the credits
 *   place opens with "<App> is open source, under the GPL-3.0 licence." and "View the source code", which opens the
 *   public client repository in the browser; the TV, which has no browser and no typing, shows the address and a QR code.
 */
// @req UX-SET-03[badger-mobile] @req UX-SET-03[badger-tv] @req UX-SET-03[parrot]
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

const openURL = vi.fn((_url: string) => Promise.resolve());
vi.mock("react-native", () => ({
  Linking: { openURL: (url: string) => openURL(url) },
  Pressable: "Pressable",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("../src/pairing-qr", () => ({ QrCode: "QrCode" }));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({ colors: { text: "#fff", textMuted: "#aaa", accent: "#ffb357" }, font: { family: { sans: "Inter" } } }),
}));

import { PUBLIC_CLIENT_REPO_URL } from "@space/shared/publicClientRepo";
import { MobileOpenSourceNotice } from "../src/components/mobile-open-source-notice";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const texts = (renderer: ReactTestRenderer) =>
  renderer.root.findAll((node: { type: unknown }) => node.type === "Text").map((node) => node.props.children as string);
const byTestId = (renderer: ReactTestRenderer, testID: string) =>
  renderer.root.findAll((node: { props: { testID?: string }; type: unknown }) => node.props.testID === testID && typeof node.type === "string");

describe("MobileOpenSourceNotice", () => {
  it.each([
    ["en", "parrot", "Parrot is open source, under the GPL-3.0 licence.", "View the source code", "Language flags: Noto Emoji artwork by Google, under the Apache License 2.0.", "Fonts: Inter and Space Grotesk, under the SIL Open Font License 1.1."],
    ["fr", "badger", "Badger est un logiciel libre, sous licence GPL-3.0.", "Voir le code source", "Drapeaux des langues : illustrations Noto Emoji de Google, sous licence Apache 2.0.", "Polices : Inter et Space Grotesk, sous licence SIL Open Font License 1.1."],
  ] as const)("@req UX-SET-03 phone: GPL line, a link that opens the repository, the flags and fonts credits (%s, %s)", (language, product, notice, link, flags, fonts) => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<MobileOpenSourceNotice language={language} product={product} openLinks />);
    });
    console.info(`[MOBILE-SHELL-OSS-001] phone ${language}/${product}: ${JSON.stringify(texts(renderer))}`);
    expect(texts(renderer)).toEqual([notice, link, flags, fonts]);
    expect(byTestId(renderer, "open-source-fonts")).toHaveLength(1);
    const [pressable] = byTestId(renderer, "open-source-link");
    expect(pressable?.props.accessibilityRole).toBe("link");
    act(() => pressable?.props.onPress());
    expect(openURL).toHaveBeenCalledWith(PUBLIC_CLIENT_REPO_URL);
    expect(PUBLIC_CLIENT_REPO_URL).toBe("https://github.com/spacefleet-io/clients");
  });

  it("@req UX-SET-03 TV: GPL line, the address as text and a QR code, nothing to open", () => {
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(<MobileOpenSourceNotice language="en" product="badger" openLinks={false} scale={1.5} />);
    });
    console.info(`[MOBILE-SHELL-OSS-001] tv: ${JSON.stringify(texts(renderer))}`);
    expect(texts(renderer)).toEqual([
      "Badger is open source, under the GPL-3.0 licence.",
      "View the source code",
      "github.com/spacefleet-io/clients",
      "Language flags: Noto Emoji artwork by Google, under the Apache License 2.0.",
      "Fonts: Inter and Space Grotesk, under the SIL Open Font License 1.1.",
    ]);
    expect(byTestId(renderer, "open-source-link")).toHaveLength(0);
    const [qr] = renderer.root.findAll((node: { type: unknown }) => node.type === "QrCode");
    expect(qr?.props.payload).toBe(PUBLIC_CLIENT_REPO_URL);
  });
});
