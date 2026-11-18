/**
 * @test-id PARROT-MOBILE-ARTIST-PHOTO-LOADING-001
 * @level unit
 * @req PAR-META-20[parrot]
 * @why Chris 2026-11-16: loading must never look like "not found". While an artist's photo is first read the phone's
 *   artist page shows a round shimmer where the photo goes; a found photo shows as the picture (which shimmers on its
 *   own while it downloads, tests/cover-fade.test.tsx); while the automatic photo pass still has the artist to ask it
 *   shimmers too; an artist with no photo, once nothing is in flight, shows nothing there. The screen is
 *   called as a function against a mocked React Native, with the photo read faked.
 * @covers apps/parrot/mobile/src/screens/ArtistScreen.tsx
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
  return { ...actual, useRef, useState, useEffect, default: { ...actual, useRef, useState, useEffect } };
});
vi.mock("react-native", () => ({ Linking: { openURL: async () => undefined }, Text: "Text", View: "View" }));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: () => undefined }) }));
vi.mock("lucide-react-native", () => ({ Trash2: "Icon:Trash2" }));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../src/state/useQuery", () => ({
  // The first query is the albums, the second the photo.
  useQuery: (load: () => unknown) => (String(load).includes("readArtistPicture") ? fake.picture : { loading: false, error: null, data: [] }),
}));
vi.mock("../src/state/manage", () => ({ useManage: () => ({ remove: () => undefined }) }));
vi.mock("../src/state/session", () => ({ useSession: () => ({ library: { status: "ready", error: null, version: 3 } }) }));
vi.mock("../src/lib/library", () => ({ listArtistAlbums: async () => [], readArtistPicture: async () => null }));
vi.mock("../src/screens/AlbumGrid", () => ({ AlbumGrid: "AlbumGrid" }));
vi.mock("../src/screens/kept", () => ({ useOfflineReach: () => null }));
vi.mock("../src/screens/art", () => ({ ParrotArt: "ParrotArt" }));
vi.mock("../src/screens/shimmer", () => ({ Shimmer: "Shimmer" }));
vi.mock("../src/screens/ui", () => ({ ErrorText: "ErrorText", IconButton: "IconButton", Title: "Title" }));
vi.mock("../src/screens/sky", () => ({ ParrotSky: ({ children }: { children: unknown }) => children }));
vi.mock("../src/screens/pageBack", () => ({ PageBackButton: "PageBackButton", usePageTop: () => 120 }));

import { ArtistScreen } from "../src/screens/ArtistScreen";
import { artistPicturesWaiting } from "../src/lib/picturesWaiting";

type Element = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const all = (node: unknown, match: (el: Element) => boolean, out: Element[] = []): Element[] => {
  if (Array.isArray(node)) node.forEach((child) => all(child, match, out));
  else if (node && typeof node === "object") {
    const element = node as Element;
    if (match(element)) out.push(element);
    all(element.props?.children, match, out);
    all(element.props?.header, match, out);
  }
  return out;
};

const render = () => (ArtistScreen as unknown as (props: unknown) => unknown)({ route: { params: { artistId: "ar-lp", name: "Linnet Park" } } });
const shown = () => {
  const tree = render();
  const result = {
    shimmer: all(tree, (el) => el.props?.testID === "artist-photo-shimmer").length,
    photo: all(tree, (el) => el.type === "ParrotArt").length,
  };
  log("shown", { picture: fake.picture, ...result });
  return result;
};

describe("PARROT-MOBILE-ARTIST-PHOTO-LOADING-001 the artist photo while it loads", () => {
  it("shimmers while the photo is first read, never showing an empty spot that looks like no photo", () => {
    fake.picture = { loading: true, error: null, data: null };
    expect(shown()).toEqual({ shimmer: 1, photo: 0 });
  });

  it("shows the photo once found, and nothing for an artist with none", () => {
    fake.picture = { loading: false, error: null, data: { pictureObjectKey: "obj-lp", pictureThumbObjectKey: null, credit: null } };
    expect(shown()).toEqual({ shimmer: 0, photo: 1 });
    fake.picture = { loading: false, error: null, data: null };
    expect(shown()).toEqual({ shimmer: 0, photo: 0 });
  });

  it("shimmers while the photo pass still has the artist to ask, and shows nothing once it answered with none", () => {
    fake.picture = { loading: false, error: null, data: null };
    artistPicturesWaiting.set(["ar-lp"]);
    expect(shown()).toEqual({ shimmer: 1, photo: 0 });
    artistPicturesWaiting.set(["ar-other"]);
    expect(shown()).toEqual({ shimmer: 0, photo: 0 });
    artistPicturesWaiting.clear();
  });
});
