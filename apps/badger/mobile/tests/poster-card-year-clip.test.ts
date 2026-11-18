/**
 * @test-id MOBILE-POSTER-YEAR-001
 * @level unit
 * @why A poster's year sits on the card's bottom line, starting at x = 0. The card clips its children
 *   (`overflow: "hidden"`, kept so the press ripple follows the poster's rounded top). With a 14 dp radius
 *   on its BOTTOM corners too, the clip cut the bottom-left of the year's first digit: "2011" drew as
 *   "?011" under every poster (emulator QA 2026-11-08, screenshots badger2-09-home / badger2-21-home-fixed).
 * @bugfix @regression-proof
 *   Rounding the card's bottom corners again (`borderRadius`, `borderBottomLeftRadius`,
 *   `borderBottomRightRadius`) while it clips fails this test.
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { PosterCard } from "../src/components/PosterCard";

vi.mock("react-native", () => ({
  StyleSheet: { create: <T>(styles: T) => styles },
  View: "View",
  Text: "Text",
  Image: "Image",
  Pressable: "Pressable",
}));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("lucide-react-native", () => ({ ArrowDownToLine: () => null }));
vi.mock("../src/components/MediaArtwork", () => ({ MediaArtwork: () => null }));
vi.mock("../src/lib/imageLog", () => ({ logImageError: () => () => undefined }));
vi.mock("../src/lib/downloads/downloadsStore", () => ({ useIsMediaDownloaded: () => false }));
vi.mock("../src/lib/useLibraryOnline", () => ({ useLibraryOnline: () => true }));
vi.mock("../src/theme/theme", () => ({
  theme: { accentTextHex: "#000", colors: { surface: "#111", border: "#222", accent: "#f80", text: "#fff", textDim: "#aaa" } },
}));

const flatten = (style: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  const walk = (s: unknown) => {
    if (Array.isArray(s)) s.forEach(walk);
    else if (s && typeof s === "object") Object.assign(out, s);
  };
  walk(style);
  return out;
};

const log = (msg: string, data?: unknown) =>
  console.log(`[MOBILE-POSTER-YEAR-001] ${msg}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

describe("poster card footer", () => {
  it("does not clip the year under the poster with a rounded bottom corner", async () => {
    const item = { id: "m1", title: "Game of Thrones", year: 2011, posterPath: null, progressPct: 0 };
    let mounted: ReactTestRenderer | null = null;
    await act(async () => {
      mounted = create(React.createElement(PosterCard, { item: item as never, width: 120, onPress: () => undefined }));
    });
    const renderer = mounted as ReactTestRenderer | null;
    if (!renderer) throw new Error("PosterCard did not mount");
    const root = renderer.root;
    const card = root.find((node: ReactTestInstance) => String(node.type) === "Pressable");
    const cardStyle = flatten(card.props.style);
    const texts = root.findAll((node: ReactTestInstance) => String(node.type) === "Text");
    const yearText = texts[texts.length - 1]!;
    log("card style", cardStyle);
    log("footer texts", texts.map((t) => ({ children: t.props.children, style: flatten(t.props.style) })));

    expect(yearText.props.children).toBe(2011);
    // The year is the last line of the card and starts at its left edge: nothing clips it unless the card does.
    const clips = cardStyle.overflow === "hidden";
    const bottomLeft = Number(cardStyle.borderBottomLeftRadius ?? cardStyle.borderRadius ?? 0);
    const bottomRight = Number(cardStyle.borderBottomRightRadius ?? cardStyle.borderRadius ?? 0);
    log("clip", { clips, bottomLeft, bottomRight });
    if (clips) {
      expect(bottomLeft, "a rounded bottom-left corner clips the year's first digit").toBe(0);
      expect(bottomRight, "a rounded bottom-right corner clips the end of a long title line").toBe(0);
    }
    act(() => renderer.unmount());
  });
});
