/**
 * @test-id MOBILE-POSTER-OFFLINE-001
 * @level unit
 * @req OFFL-PLAY-03
 * @why Offline, a poster whose title has nothing downloaded on the phone is greyed (UNAVAILABLE_LOOK on its content)
 *   and does not open; a downloaded title stays in colour and opens; online, nothing is greyed.
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { UNAVAILABLE_LOOK } from "@space/mobile-shell/theme";

const net = vi.hoisted(() => ({ online: true, downloaded: new Set<string>() }));

vi.mock("react-native", () => ({
  StyleSheet: { create: <T>(styles: T) => styles },
  View: "View",
  Text: "Text",
  Image: "Image",
  Pressable: "Pressable",
}));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("lucide-react-native", () => ({ ArrowDownToLine: () => null, Check: () => null }));
vi.mock("../src/components/MediaArtwork", () => ({ MediaArtwork: () => null }));
vi.mock("../src/lib/imageLog", () => ({ logImageError: () => () => undefined }));
vi.mock("../src/lib/downloads/downloadsStore", () => ({ useIsMediaDownloaded: (id: string) => net.downloaded.has(id) }));
vi.mock("../src/lib/useLibraryOnline", () => ({ useLibraryOnline: () => net.online }));
vi.mock("../src/theme/theme", () => ({
  theme: { accentTextHex: "#000", colors: { surface: "#111", border: "#222", accent: "#f80", text: "#fff", textMuted: "#aaa" } },
}));

import { PosterCard } from "../src/components/PosterCard";

const flatten = (style: unknown): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  const walk = (s: unknown) => {
    if (Array.isArray(s)) s.forEach(walk);
    else if (s && typeof s === "object") Object.assign(out, s);
  };
  walk(style);
  return out;
};

const mount = async (id: string) => {
  const onPress = vi.fn();
  let renderer: ReactTestRenderer | null = null;
  await act(async () => {
    renderer = create(
      React.createElement(PosterCard, {
        item: { id, title: `Title ${id}`, year: 2011, posterPath: null, progressPct: 0 } as never,
        width: 120,
        onPress,
      }),
    );
  });
  if (!renderer) throw new Error("PosterCard did not mount");
  const mounted = renderer as ReactTestRenderer;
  const card = mounted.root.find((node: ReactTestInstance) => String(node.type) === "Pressable");
  const poster = card.findAll((node: ReactTestInstance) => String(node.type) === "View")[0]!;
  const state = {
    id,
    disabled: Boolean(card.props.disabled),
    a11yDisabled: Boolean(card.props.accessibilityState?.disabled),
    posterOpacity: flatten(poster.props.style).opacity ?? null,
    titleOpacity: flatten(card.findAll((node: ReactTestInstance) => String(node.type) === "Text")[0]!.props.style).opacity ?? null,
  };
  console.info(JSON.stringify({ test: "MOBILE-POSTER-OFFLINE-001", online: net.online, ...state }));
  if (!card.props.disabled) act(() => card.props.onPress());
  act(() => mounted.unmount());
  return { ...state, opened: onPress.mock.calls.length > 0 };
};

describe("poster card offline (OFFL-PLAY-03)", () => {
  it("greys and disables a title with nothing on the phone while offline, and keeps a downloaded one", async () => {
    net.online = false;
    net.downloaded = new Set(["kept"]);
    const away = await mount("away");
    const kept = await mount("kept");
    expect(away.disabled).toBe(true);
    expect(away.a11yDisabled).toBe(true);
    expect(away.posterOpacity).toBe(UNAVAILABLE_LOOK.opacity);
    expect(away.titleOpacity).toBe(UNAVAILABLE_LOOK.opacity);
    expect(away.opened).toBe(false);
    expect(kept.disabled).toBe(false);
    expect(kept.posterOpacity).toBeNull();
    expect(kept.opened).toBe(true);
  });

  it("greys nothing online", async () => {
    net.online = true;
    net.downloaded = new Set();
    const any = await mount("any");
    expect(any.disabled).toBe(false);
    expect(any.posterOpacity).toBeNull();
    expect(any.opened).toBe(true);
  });
});
