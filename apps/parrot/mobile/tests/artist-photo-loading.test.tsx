/**
 * @test-id PARROT-MOBILE-ARTIST-PHOTO-LOADING-001
 * @level unit
 * @req PAR-META-20[parrot]
 * @req PAR-LOOK-06[parrot]
 * @why Chris 2026-11-16: loading must never look like "not found". While an artist's photo is first read the phone's
 *   artist page shows a shimmer where the photo goes, edge to edge at the top (PAR-LOOK-06); a found photo shows as the
 *   picture (which shimmers on its own while it downloads, tests/cover-fade.test.tsx); while the automatic photo pass
 *   still has the artist to ask it shimmers too; an artist with no photo, once nothing is in flight, shows the drawn
 *   picture with their initials. The screen is called as a function against a mocked React Native, its own components
 *   expanded, with the photo read faked.
 * @covers apps/parrot/mobile/src/screens/ArtistScreen.tsx
 * @covers apps/parrot/mobile/src/screens/artist/pieces.tsx
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";

const log = (phase: string, detail: unknown = {}) => console.info(`[PARROT-MOBILE-ARTIST-PHOTO-LOADING-001] phase=${phase}`, JSON.stringify(detail));

const fake = vi.hoisted(() => ({
  picture: { loading: true, error: null as string | null, data: null as null | { pictureObjectKey: string; pictureThumbObjectKey: string | null; credit: null } },
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  // Called outside a render: each call starts with no photo read yet, and reads the waiting list as it is now.
  const useRef = <T,>(initial: T) => ({ current: initial });
  const useState = <T,>(initial: T) => [initial, () => undefined];
  const useEffect = () => undefined;
  const useMemo = <T,>(fn: () => T) => fn();
  const hooks = { useRef, useState, useEffect, useMemo };
  return { ...actual, ...hooks, default: { ...actual, ...hooks } };
});
vi.mock("react-native", () => ({
  Linking: { openURL: async () => undefined },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: <T extends Record<string, unknown>>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
  Text: "Text",
  View: "View",
  useWindowDimensions: () => ({ width: 400, height: 800 }),
}));
vi.mock("react-native-svg", () => ({ default: "Svg", Defs: "Defs", LinearGradient: "LinearGradient", Rect: "Rect", Stop: "Stop" }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: () => undefined }) }));
vi.mock("lucide-react-native", () =>
  Object.fromEntries(
    ["ArrowDownToLine", "ChevronLeft", "CircleCheck", "Ellipsis", "ListEnd", "ListPlus", "ListStart", "Play", "Shuffle", "Trash2"].map((name) => [name, `Icon:${name}`])
  )
);
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// The real rail (Discography's year row, UX-PHONE-09) without the barrel's native modules (reanimated).
vi.mock("@space/mobile-shell/components", async () => ({
  MobileRailScroll: (await vi.importActual<typeof import("@space/mobile-shell/rail")>("@space/mobile-shell/rail")).MobileRailScroll,
  MobileSkeletonPulse: "Shimmer",
  MobileIconButton: "MobileIconButton",
  MOBILE_ICON_BUTTON_SIZE: 48,
}));
vi.mock("../src/state/useQuery", () => ({
  useQuery: (load: () => unknown) => (String(load).includes("readArtistPicture") ? fake.picture : { loading: false, error: null, data: [] }),
}));
vi.mock("../src/state/manage", () => ({ useManage: () => ({ remove: () => undefined }) }));
vi.mock("../src/state/session", () => ({ useSession: () => ({ library: { status: "ready", error: null, version: 3 } }) }));
vi.mock("../src/state/usePlay", () => ({ usePlay: () => ({ play: async () => undefined, queue: async () => undefined, starting: null, error: null }) }));
vi.mock("../src/state/usePlayerState", () => ({ useNowPlaying: () => null }));
vi.mock("../src/state/playlistEditor", () => ({ usePlaylistEditor: () => ({}) }));
vi.mock("../src/lib/library", () => ({ listArtistAlbums: async () => [], listSongs: async () => [], readArtistPicture: async () => null }));
vi.mock("../src/screens/kept", () => ({ useKept: () => ({ entry: () => undefined }), useOfflineReach: () => null }));
vi.mock("../src/screens/art", () => ({ ParrotArt: "ParrotArt" }));
vi.mock("../src/screens/ui", () => ({ ErrorText: "ErrorText" }));
vi.mock("../src/screens/sky", () => ({ ParrotSky: "ParrotSky" }));
vi.mock("../src/screens/pageBack", () => ({ PageBackButton: "PageBackButton", PAGE_BACK_ROW: 60, usePageTop: () => 120 }));
vi.mock("../src/screens/SongListRow", () => ({ SongListRow: "SongListRow" }));

import { ArtistScreen } from "../src/screens/ArtistScreen";
import { artistPicturesWaiting } from "../src/lib/picturesWaiting";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const expand = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== "object") return node;
  const element = node as Element;
  if (typeof element.type === "function") return expand((element.type as (props: unknown) => unknown)(element.props));
  return { ...element, props: { ...element.props, children: expand(element.props?.children) } };
};
const all = (node: unknown, match: (el: Element) => boolean, out: Element[] = []): Element[] => {
  if (Array.isArray(node)) node.forEach((child) => all(child, match, out));
  else if (node && typeof node === "object") {
    const element = node as Element;
    if (match(element)) out.push(element);
    all(element.props?.children, match, out);
  }
  return out;
};

const render = () =>
  expand((ArtistScreen as unknown as (props: unknown) => unknown)({ route: { params: { artistId: "ar-lp", name: "Linnet Park" } }, navigation: { goBack: () => undefined } }));
const shown = () => {
  const page = render();
  const hero = all(page, (el) => el.props?.testID === "artist-hero");
  const art = all(hero, (el) => el.type === "ParrotArt");
  const result = {
    shimmer: all(hero, (el) => el.props?.testID === "artist-photo-shimmer").length,
    photo: art.filter((el) => el.props.coverKey).length,
    drawn: art.filter((el) => !el.props.coverKey).length,
    initials: all(all(page, (el) => el.props?.testID === "artist-initials"), (el) => el.type === "Text" && el.props.children === "LP").length,
  };
  log("shown", { picture: fake.picture, ...result });
  return result;
};

describe("PARROT-MOBILE-ARTIST-PHOTO-LOADING-001 the artist photo while it loads", () => {
  it("shimmers while the photo is first read, never showing the drawn picture that means no photo", () => {
    fake.picture = { loading: true, error: null, data: null };
    expect(shown()).toEqual({ shimmer: 1, photo: 0, drawn: 0, initials: 0 });
  });

  it("shows the photo once found, and the drawn picture with the initials for an artist with none", () => {
    fake.picture = { loading: false, error: null, data: { pictureObjectKey: "obj-lp", pictureThumbObjectKey: null, credit: null } };
    expect(shown()).toEqual({ shimmer: 0, photo: 1, drawn: 0, initials: 0 });
    fake.picture = { loading: false, error: null, data: null };
    expect(shown()).toEqual({ shimmer: 0, photo: 0, drawn: 1, initials: 1 });
  });

  it("shimmers while the photo pass still has the artist to ask, and draws the picture once it answered with none", () => {
    fake.picture = { loading: false, error: null, data: null };
    artistPicturesWaiting.set(["ar-lp"]);
    expect(shown()).toEqual({ shimmer: 1, photo: 0, drawn: 0, initials: 0 });
    artistPicturesWaiting.set(["ar-other"]);
    expect(shown()).toEqual({ shimmer: 0, photo: 0, drawn: 1, initials: 1 });
    artistPicturesWaiting.clear();
  });
});
