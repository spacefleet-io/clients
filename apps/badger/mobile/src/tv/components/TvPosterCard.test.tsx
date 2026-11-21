/**
 * TV-CARD-POSTER-001 (UX-TV-05): every Home row shows posters, Continue watching included (Chris 2026-10-28: the row
 * showed the wide picture instead). A Continue watching card asks for the poster, never the wide picture, and shows the
 * year under the title like desktop (Chris 2026-10-29: "I prefer the year"), no longer "S1 · E3 · 18 min left".
 * TV-CARD-CAPTION-001 (UX-TV-11, UX-TV-34, approved TV design Chris 2026-11-12 (chat)): the card is the mockup's `.pc`: a
 * rounded 2:3 poster, the title on one line and the year in grey under it ("—" when unknown), a thin amber bar inside
 * the poster while watching and an amber check once watched. Under the focus the poster alone takes the amber ring and
 * grows, and the caption moves down into room the card already keeps, so the ring never touches the title.
 * TV-SCALE-CARD-001 (UX-TV-13): on an Apple TV (1920x1080 points) the card is the Android TV card (960x540 dp) at twice
 * the size, so its caption reads the same from the sofa (Chris 2026-11-06: "the font is way too small").
 * Rendered with react-test-renderer: react-native is replaced by host-element stand-ins.
 *
 * @req UX-TV-05[badger-tv]
 * @req UX-TV-11[badger-tv]
 * @req UX-A11Y-04[badger-tv]
 * @req UX-TV-13[badger-tv]
 * @req UX-TV-34[badger-tv]
 * @req UX-TV-35[badger-tv]
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { MediaRow } from "@space/shared/libraryTypes";
import { TV_CAPTION_FOCUS_SHIFT, TV_CAPTION_GAP, TvPosterCard, tvPosterCardHeight } from "./TvPosterCard";

/** The window the card renders in: 960x540 dp (Android TV at 1080p) or 1920x1080 pt (Apple TV). */
const windowSize = vi.hoisted(() => ({ width: 960, height: 540 }));
const progress = vi.hoisted(() => ({ value: 40 }));

vi.mock("react-native", async () => {
  const host = (name: string) => name;
  return {
    ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
    View: host("View"),
    Text: host("Text"),
    StyleSheet: { create: <T,>(styles: T) => styles },
    useWindowDimensions: () => windowSize,
  };
});
vi.mock("lucide-react-native", () => ({ Check: "CheckIcon", Film: "FilmIcon", Tv: "TvIcon" }));
vi.mock("@space/shared/playbackResume", () => ({ COMPLETED_PCT_THRESHOLD: 90 }));
vi.mock("@space/mobile-shell/i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../components/PosterCard", () => ({ POSTER_ASPECT: 1.5, posterLabel: () => "label", posterProgress: () => progress.value }));
// The picture's own states (spinner, fade, fallback) are MobileArtworkImage's tests (UX-WAIT-03); here, which picture.
vi.mock("../../components/MediaArtwork", () => ({ MediaArtwork: "MediaArtwork" }));
vi.mock("../../theme/theme", () => ({
  theme: {
    colors: { bg: "#000", surface: "#111", surfaceRaised: "#222", border: "#333", accent: "#f0f", text: "#fff", textMuted: "#888", danger: "#f00" },
    accentTextHex: "#000",
    font: { family: { sans: "Inter", display: "SpaceGrotesk" } },
  },
}));
vi.mock("@space/mobile-shell/tv/TvFocusable", () => ({ TvFocusable: "TvFocusable" }));
vi.mock("../lib/useFocusAfterScreenAppears", () => ({ useFocusAfterScreenAppears: () => () => undefined }));
vi.mock("../../lib/imageLog", () => ({ logImageError: () => () => undefined }));

const friends = { id: "friends", type: "tv", title: "Friends", year: 1994, posterPath: "/poster.jpg", backdropPath: "/wide.jpg" } as unknown as MediaRow;
const heat = { id: "heat", type: "movie", title: "Heat", year: null, posterPath: "/heat.jpg" } as unknown as MediaRow;

const render = (element: React.ReactElement): ReactTestRenderer => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = create(element);
  });
  return tree;
};
const isType = (node: ReactTestInstance, type: string) => (node.type as unknown) === type;
const flat = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) as Record<string, number | string>;
const texts = (tree: ReactTestRenderer) => tree.root.findAll((n) => isType(n, "Text")).map((n) => n.props.children);
const byId = (tree: ReactTestRenderer, testID: string) => tree.root.findByProps({ testID });

describe("TvPosterCard (TV-CARD-POSTER-001)", () => {
  it("@req UX-TV-05 a Continue watching card shows the poster and the year, not what is left", () => {
    const tree = render(<TvPosterCard item={friends} width={112} onPress={() => undefined} showProgress showType />);
    const poster = tree.root.find((n) => isType(n, "MediaArtwork"));
    console.info("[TV-CARD-POSTER-001] poster", JSON.stringify({ path: poster.props.path, kind: poster.props.kind, label: poster.props.label }), "texts", JSON.stringify(texts(tree)));
    expect(poster.props).toMatchObject({ path: "/poster.jpg", kind: "poster", label: "Friends" });
    expect(texts(tree)).toEqual(["Friends", 1994]);
    expect(texts(tree).some((text) => String(text).includes("left"))).toBe(false);
  });

  it("@req UX-TV-05 a library card shows the year too", () => {
    const tree = render(<TvPosterCard item={friends} width={112} onPress={() => undefined} />);
    console.info("[TV-CARD-POSTER-001] texts", JSON.stringify(texts(tree)));
    expect(texts(tree)).toEqual(["Friends", 1994]);
  });
});

describe("TvPosterCard caption and watch state (TV-CARD-CAPTION-001)", () => {
  it("@req UX-TV-11 @req UX-TV-34 a Home row card shows the title on one line, then the type mark and the year", () => {
    const show = render(<TvPosterCard item={friends} width={150} onPress={() => undefined} showType />);
    const film = render(<TvPosterCard item={heat} width={150} onPress={() => undefined} showType />);
    const mark = (tree: ReactTestRenderer) => byId(tree, "tv-card-type").findAll((n) => isType(n, "FilmIcon") || isType(n, "TvIcon"))[0];
    const title = show.root.find((n) => isType(n, "Text") && n.props.children === "Friends");
    console.info("[TV-CARD-CAPTION-001] row captions", JSON.stringify({ show: texts(show), film: texts(film), lines: title.props.numberOfLines }));
    expect(String(mark(show).type)).toBe("TvIcon");
    expect(String(mark(film).type)).toBe("FilmIcon");
    expect(title.props.numberOfLines).toBe(1);
    expect(texts(show)).toEqual(["Friends", 1994]);
    // A dash when the year is unknown.
    expect(texts(film)).toEqual(["Heat", "—"]);
  });

  it("@req UX-TV-11 a library card has the caption without the type mark", () => {
    const tree = render(<TvPosterCard item={friends} width={150} onPress={() => undefined} />);
    expect(tree.root.findAll((n) => n.props.testID === "tv-card-type")).toHaveLength(0);
    expect(texts(tree)).toEqual(["Friends", 1994]);
  });

  it("@req UX-TV-34 while watching, a thin amber bar sits inside the poster's bottom edge", () => {
    progress.value = 40;
    const tree = render(<TvPosterCard item={friends} width={150} onPress={() => undefined} showProgress showType />);
    const bar = byId(tree, "tv-card-progress");
    const fill = bar.findAll((n) => isType(n, "View") && n !== bar)[0];
    console.info("[TV-CARD-CAPTION-001] progress", JSON.stringify({ bar: flat(bar.props.style), fill: flat(fill.props.style) }));
    expect(byId(tree, "tv-card-picture").findAll((n) => n === bar)).toHaveLength(1);
    expect(flat(bar.props.style).position).toBe("absolute");
    expect(flat(fill.props.style).width).toBe("40%");
    expect(tree.root.findAll((n) => n.props.testID === "tv-card-watched")).toHaveLength(0);
  });

  it("@req UX-TV-34 once watched, the card shows the amber check and no bar; without the watch state it shows neither", () => {
    progress.value = 95;
    try {
      const watched = render(<TvPosterCard item={friends} width={150} onPress={() => undefined} showProgress />);
      expect(byId(watched, "tv-card-picture").findAll((n) => n.props.testID === "tv-card-watched")).toHaveLength(1);
      expect(watched.root.findAll((n) => n.props.testID === "tv-card-progress")).toHaveLength(0);
      const plain = render(<TvPosterCard item={friends} width={150} onPress={() => undefined} />);
      expect(plain.root.findAll((n) => n.props.testID === "tv-card-watched" || n.props.testID === "tv-card-progress")).toHaveLength(0);
    } finally {
      progress.value = 40;
    }
  });

  it("@req UX-TV-35 @req UX-A11Y-04 under the focus the poster takes the ring and grows, and the caption moves down", () => {
    const tree = render(<TvPosterCard item={friends} width={150} onPress={() => undefined} showType />);
    const focusable = tree.root.find((n) => isType(n, "TvFocusable"));
    // The card draws its own ring on the poster, so the focusable draws none and does not grow.
    expect(focusable.props.ring).toBe("none");
    expect(focusable.props.scale).toBe(1);
    const before = { picture: flat(byId(tree, "tv-card-picture").props.style), caption: flat(byId(tree, "tv-card-caption").props.style) };
    expect(before.picture.outlineWidth).toBeUndefined();
    act(() => focusable.props.onFocus());
    const picture = flat(byId(tree, "tv-card-picture").props.style);
    const caption = byId(tree, "tv-card-caption").props.style;
    console.info("[TV-CARD-CAPTION-001] focused", JSON.stringify({ picture, caption }));
    expect(Number(picture.outlineWidth)).toBeGreaterThan(0);
    expect(Number(picture.outlineOffset)).toBeGreaterThan(0);
    expect(picture.transform).toEqual([{ scale: 1.06 }]);
    expect(flat(caption).transform).toEqual([{ translateY: TV_CAPTION_FOCUS_SHIFT }]);
    act(() => focusable.props.onBlur());
    expect(flat(byId(tree, "tv-card-picture").props.style).outlineWidth).toBeUndefined();
  });

  it("@req UX-TV-34 the card height is the 2:3 poster plus the caption and the room the focused caption moves into", () => {
    const tree = render(<TvPosterCard item={friends} width={150} onPress={() => undefined} />);
    const picture = flat(byId(tree, "tv-card-picture").props.style);
    console.info("[TV-CARD-CAPTION-001] heights", JSON.stringify({ card: tvPosterCardHeight(150, 1), picture: picture.height }));
    expect(picture.height).toBe(225);
    expect(tvPosterCardHeight(150, 1)).toBe(225 + TV_CAPTION_GAP + TV_CAPTION_FOCUS_SHIFT + 14 + 2 + 12);
  });
});

describe("TvPosterCard on an Apple TV (TV-SCALE-CARD-001)", () => {
  const renderAt = (width: number, height: number, cardWidth: number) => {
    windowSize.width = width;
    windowSize.height = height;
    try {
      const tree = render(<TvPosterCard item={friends} width={cardWidth} onPress={() => undefined} showProgress showType />);
      const title = tree.root.find((n) => isType(n, "Text") && n.props.children === "Friends");
      const icon = byId(tree, "tv-card-type").findAll((n) => isType(n, "TvIcon"))[0];
      return {
        picture: flat(byId(tree, "tv-card-picture").props.style),
        caption: flat(byId(tree, "tv-card-caption").props.style),
        bar: flat(byId(tree, "tv-card-progress").props.style),
        title: flat(title.props.style),
        iconSize: icon.props.size as number,
      };
    } finally {
      windowSize.width = 960;
      windowSize.height = 540;
    }
  };

  it("@req UX-TV-13 a 1920x1080-point window draws the 960x540 card at exactly twice the size", () => {
    const android = renderAt(960, 540, 150);
    const apple = renderAt(1920, 1080, 300);
    console.info("[TV-SCALE-CARD-001] rendered", JSON.stringify({ android, apple }));
    expect(android.picture.height).toBe(225);
    for (const part of ["picture", "caption", "bar", "title"] as const) {
      for (const key of ["borderRadius", "height", "width", "marginTop", "fontSize", "lineHeight", "left", "bottom"]) {
        const before = android[part][key];
        if (typeof before !== "number") continue;
        expect(apple[part][key]).toBe(before * 2);
      }
    }
    expect(apple.iconSize).toBe(android.iconSize * 2);
  });

  it("@req UX-TV-13 the card height doubles with the scale", () => {
    expect(tvPosterCardHeight(300, 2)).toBe(tvPosterCardHeight(150, 1) * 2);
  });
});
