/**
 * @test-id TV-DETAILS-RESUME-001
 * @level component
 * @why A show's Play button on the TV details offers the show's last-played episode ("Resume S1E02"). Back from the
 *   player, the details screen is the same instance (it only regains focus), and it read the last-played episode on
 *   mount only: after watching E2 past both resume thresholds, Play still offered the episode played before it (seen on
 *   the Apple TV simulator 2026-10-23: "Resume S1E01" after E2 stopped at 304 s). Rendered with react-test-renderer:
 *   react-native is replaced by host-element stand-ins, the library and the stored last-played episode by fakes.
 *
 * @bugfix @regression-proof
 * @req PLAY-RESUME-01[badger-tv]
 * @req PLAT-TV-02[badger-tv]
 * @req UX-TV-06[badger-tv]
 */
import React from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLanguage, initI18n } from "@space/mobile-shell/i18n";
import { QrCode } from "@space/mobile-shell/pairing-qr";
import { getStorageUnitBase, setStorageUnitBase } from "@space/shared/format";
import type { MediaDetails, MediaFormat } from "@space/shared/libraryTypes";
import type { EpisodeResume } from "@space/shared/playbackResume";
import { bumpLibraryRevision } from "../../lib/libraryRevision";
import { setCurrentTvSection } from "../lib/tvSection";
import type * as TvSectionModule from "../lib/tvSection";
import { TV_DETAILS_POSTER_WIDTH, TvMediaDetailsScreen } from "./TvMediaDetailsScreen";

const DURATION = 13698;

const ctl = vi.hoisted(() => ({
  mediaId: "show-1",
  lastPlayed: null as string | null,
  resume: {} as Record<string, unknown>,
  focusListeners: [] as Array<() => void>,
  backListeners: [] as Array<() => boolean>,
  details: {} as Record<string, unknown>,
  library: null as unknown,
  navigated: [] as Array<{ name: string; params: unknown }>,
  wentBack: 0,
  openedUrls: [] as string[],
  focused: [] as string[],
  failingUrls: new Set<string>(),
  youtubeAppInstalled: true,
  queriedUrls: [] as string[],
  os: "android" as "android" | "ios",
  warmed: [] as Array<{ token: string | null; mediaId: string; episodeId: string | null }>,
  token: null as string | null,
  /** TMDB's synopsis per language ("de", "en", …), what the metadata service answers (LIB-LANG-01). */
  tmdbOverviews: {} as Record<string, string>,
  askedOverviews: [] as string[],
  /** TMDB's episodes per language, what the metadata service's tv details answer carries (LIB-LANG-01). */
  tmdbEpisodes: {} as Record<string, Array<{ seasonNumber: number; episodeNumber: number; name: string | null; overview: string | null }>>,
  askedEpisodes: [] as string[],
  /** The library rows "More like this" picks from (UX-TV-40). */
  media: [] as unknown[],
  playlists: [] as Array<{ id: string; name: string }>,
  contains: {} as Record<string, boolean>,
  toggled: [] as string[],
  sections: [] as string[],
  /** The `file://` URL the image hook answers for a backdrop path (null: not on disk). */
  backdropUrl: null as string | null,
}));

vi.mock("react-native", async () => {
  const host = (name: string) => name;
  return {
    ...(await import("../../../tests/setup/reactNativeMock")).reactNativeBase(),
    View: host("View"),
    Text: host("Text"),
    Image: host("Image"),
    ScrollView: host("ScrollView"),
    ActivityIndicator: host("ActivityIndicator"),
    Pressable: host("Pressable"),
    TVFocusGuideView: host("TVFocusGuideView"),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, absoluteFillObject: {}, absoluteFill: {} },
    Platform: {
      isTV: true,
      get OS() {
        return ctl.os;
      },
      constants: {},
    },
    BackHandler: {
      addEventListener: (_name: string, listener: () => boolean) => {
        ctl.backListeners.push(listener);
        return { remove: () => ctl.backListeners.splice(ctl.backListeners.indexOf(listener), 1) };
      },
    },
    Linking: {
      openURL: async (url: string) => {
        ctl.openedUrls.push(url);
        if (ctl.failingUrls.has(url)) throw new Error(`No activity for ${url}`);
      },
      canOpenURL: async (url: string) => {
        ctl.queriedUrls.push(url);
        return ctl.youtubeAppInstalled;
      },
    },
    useWindowDimensions: () => ({ width: 960, height: 540 }),
  };
});
vi.mock("react-native-svg", () => ({
  default: "Svg",
  Defs: "Defs",
  G: "G",
  Image: "SvgImage",
  LinearGradient: "LinearGradient",
  Mask: "Mask",
  Path: "Path",
  Rect: "Rect",
  Stop: "Stop",
}));
vi.mock("lucide-react-native", () => ({
  ArrowLeft: "ArrowLeftIcon",
  Check: "CheckIcon",
  ChevronLeft: "ChevronLeftIcon",
  ChevronRight: "ChevronRightIcon",
  Clapperboard: "ClapperboardIcon",
  Ellipsis: "EllipsisIcon",
  Film: "FilmIcon",
  Home: "HomeIcon",
  Library: "LibraryIcon",
  ListPlus: "ListPlusIcon",
  Play: "PlayIcon",
  RotateCw: "RotateCwIcon",
  Search: "SearchIcon",
  Settings: "SettingsIcon",
  Tag: "TagIcon",
  Tv: "TvIcon",
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));
vi.mock("@space/mobile-shell/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@space/mobile-shell/i18n")>();
  return { ...actual, useTranslation: () => ({ t: actual.translate, i18n: { language: "en" } }) };
});
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({
    navigate: (name: string, params: unknown) => ctl.navigated.push({ name, params }),
    push: (name: string, params: unknown) => ctl.navigated.push({ name: `push:${name}`, params }),
    goBack: () => {
      ctl.wentBack += 1;
    },
    addListener: (name: string, listener: () => void) => {
      if (name !== "focus") return () => undefined;
      ctl.focusListeners.push(listener);
      return () => ctl.focusListeners.splice(ctl.focusListeners.indexOf(listener), 1);
    },
  }),
  useRoute: () => ({ params: { mediaId: ctl.mediaId } }),
}));
vi.mock("../../lib/resume", () => ({ getLastPlayedEpisodeId: async () => ctl.lastPlayed }));
vi.mock("../../lib/useMediaImage", () => ({
  useMediaImage: (path: string | null, kind: string) => (kind === "backdrop" && path ? ctl.backdropUrl : null),
}));
vi.mock("../../components/MediaArtwork", () => ({ MediaArtwork: () => null }));
vi.mock("../components/TvFocusable", () => ({ TvFocusable: "TvFocusable", FOCUS_SCALE: 1.05 }));
vi.mock("../components/TvListDialog", () => ({ TvListDialog: "TvListDialog" }));
vi.mock("../components/TvPosterCard", () => ({ TvPosterCard: "TvPosterCard", tvPosterCardHeight: () => 132 }));
vi.mock("../ui/TvTopBar", () => ({ TvTopBar: "TvTopBar", TV_BROWSE_TABS: [], TV_SETTINGS_TAB: "settings" }));
vi.mock("../ui/TvSky", () => ({ TvSky: "TvSky" }));
vi.mock("../ui/TvRow", () => ({ TvRow: "TvRow", TvRowList: "TvRowList", TvToggle: "TvToggle" }));
vi.mock("../lib/tvSection", async (importOriginal) => {
  const actual = await importOriginal<typeof TvSectionModule>();
  return {
    ...actual,
    requestTvSection: (section: string) => {
      ctl.sections.push(section);
    },
  };
});
vi.mock("../../lib/usePlaylistMembership", () => ({
  usePlaylistMembership: () => ({
    playlists: ctl.playlists,
    contains: ctl.contains,
    toggle: async (id: string) => {
      ctl.toggled.push(id);
    },
  }),
}));
vi.mock("../../store/library", () => ({
  useLibraryActions: () => ctl.library,
  useLibraryStatus: () => ctl.library,
  useLibraryData: () => ({ media: ctl.media, playlists: ctl.playlists }),
}));
vi.mock("../../store/auth", () => ({ useAuth: () => ({ token: ctl.token }) }));
vi.mock("../../lib/metadata/runtime", () => ({
  fetchOverview: async (type: string, id: number, language: string) => {
    ctl.askedOverviews.push(`${type}:${id}:${language}`);
    return ctl.tmdbOverviews[language] ?? null;
  },
  fetchEpisodes: async (id: number, language: string) => {
    ctl.askedEpisodes.push(`${id}:${language}`);
    return ctl.tmdbEpisodes[language] ?? [];
  },
}));
vi.mock("../../lib/playback/playStartWarm", () => ({
  warmPlayStart: (input: { token: string | null; mediaId: string; episodeId: string | null }) => {
    ctl.warmed.push({ token: input.token, mediaId: input.mediaId, episodeId: input.episodeId });
  },
}));

const episode = (id: string, episodeNumber: number, seasonNumber = 1) => ({
  id,
  seasonNumber,
  episodeNumber,
  name: `Episode ${episodeNumber}`,
  overview: `Synopsis of episode ${episodeNumber}.`,
  stillPath: null,
  airDate: "2022-02-18",
});

const season = (seasonNumber: number, episodeCount: number) => ({
  id: `season-${seasonNumber}`,
  seasonNumber,
  name: seasonNumber === 0 ? "Specials" : `Season ${seasonNumber}`,
  overview: null,
  posterPath: null,
  episodeCount,
  airDate: "2022-02-18",
});

const format = (id: string, fileId: string, quality: string, codec: string, extra: Partial<MediaFormat> = {}) => ({
  id,
  mediaId: "x",
  fileId,
  quality,
  codec,
  codecString: null,
  bitrateKbps: null,
  sizeMb: 2200,
  initKey: null,
  initSize: null,
  durationSeconds: 3120,
  totalSize: null,
  chunks: [],
  isSource: false,
  ...extra,
});

const track = (id: string, label: string, scope: { fileId?: string; episodeId?: string }) => ({
  id,
  mediaId: "x",
  fileId: scope.fileId ?? null,
  episodeId: scope.episodeId ?? null,
  language: "en",
  label,
  isDefault: false,
  source: "ingest",
  codec: null,
  initKey: null,
  initSize: null,
  durationSeconds: null,
  totalSize: null,
  chunks: [],
  objectKey: null,
  format: "vtt",
  createdAt: "2026-10-01T00:00:00Z",
});

const cast = [
  { id: "c1", personId: "p1", tmdbId: null, name: "Adam Scott", role: "Mark", profilePath: null },
  { id: "c2", personId: "p2", tmdbId: null, name: "Britt Lower", role: "Helly", profilePath: null },
];

const show = {
  id: "show-1",
  type: "tv",
  title: "Game of Thrones",
  year: "2011",
  rating: 8.4,
  originalLanguage: "en",
  addedAt: "2026-10-25T10:00:00Z",
  overview: "Nine noble families fight for control.",
  genres: [],
  cast,
  trailers: [],
  seasons: [season(1, 2)],
  episodes: [episode("e1", 1), episode("e2", 2)],
  files: [
    { id: "f1", season: 1, episode: 1 },
    { id: "f2", season: 1, episode: 2 },
  ],
  formats: [
    format("e1-1080", "f1", "1080p", "h264", { isSource: true }),
    format("e1-720", "f1", "720p", "h264"),
    format("e2-2160", "f2", "2160p", "hevc", { isSource: true, codecString: "dvh1.05.06", sizeMb: 8090 }),
    format("e2-1080", "f2", "1080p", "h264"),
  ],
  audioTracks: [track("a1", "English 5.1", { episodeId: "e1" }), track("a2", "English 5.1 Atmos", { episodeId: "e2" })],
  subtitleTracks: [track("s2", "French", { episodeId: "e2" })],
  progressPct: 0,
} as unknown as MediaDetails;

/**
 * Like a long-running sitcom in a real library: TMDB knows the specials and three seasons, the library has files for S1E1 and S1E2
 * only. Season 2 has episodes but no file; season 3 has none listed yet.
 */
const partialShow = {
  ...show,
  id: "show-2",
  title: "Harbour Lights",
  seasons: [season(0, 1), season(1, 3), season(2, 2), season(3, 0)],
  episodes: [episode("x1", 1, 0), episode("e1", 1), episode("e2", 2), episode("e3", 3), episode("f1", 1, 2), episode("f2", 2, 2)],
} as unknown as MediaDetails;

const movie = {
  id: "movie-1",
  type: "movie",
  title: "The Orchard House",
  year: "2005",
  rating: 7.8,
  originalLanguage: "en",
  addedAt: "2026-10-25T10:00:00Z",
  overview: "A retired gardener and her estranged son spend one last summer saving the family orchard.",
  genres: [],
  cast,
  trailers: [{ provider: "youtube", key: "abcDEF12345", name: "Trailer", language: "en" }],
  seasons: [],
  episodes: [],
  files: [{ id: "mf", season: null, episode: null }],
  formats: [
    format("m-720", "mf", "720p", "h264", { sizeMb: 1200, durationSeconds: 7740 }),
    format("m-src", "mf", "2160p", "hevc", { isSource: true, codecString: "dvh1.05.06", sizeMb: 18841.6, durationSeconds: 7740 }),
    format("m-1080", "mf", "1080p", "h264", { durationSeconds: 7740 }),
  ],
  audioTracks: [track("ma1", "English 5.1", { fileId: "mf" }), track("ma2", "French 5.1", { fileId: "mf" })],
  subtitleTracks: [track("ms1", "English SDH", { fileId: "mf" })],
  progressPct: 40,
} as unknown as MediaDetails;

const watched = (positionSeconds: number): EpisodeResume => ({
  progressPct: (positionSeconds / DURATION) * 100,
  positionSeconds,
  durationSeconds: DURATION,
  updatedAt: "2026-10-23T10:00:00Z",
});

const byId = (renderer: ReactTestRenderer, testID: string): ReactTestInstance[] =>
  renderer.root.findAll((node) => node.props.testID === testID && typeof node.type === "string");
const one = (renderer: ReactTestRenderer, testID: string): ReactTestInstance => {
  const found = byId(renderer, testID);
  if (found.length !== 1) throw new Error(`expected one ${testID}, found ${found.length}`);
  return found[0]!;
};
const playLabel = (renderer: ReactTestRenderer): string => one(renderer, "tv-details-play").props.accessibilityLabel as string;
/** Every string the tree renders (text, labels, test ids): what the TV could show or read out. */
const allText = (renderer: ReactTestRenderer): string => JSON.stringify(renderer.toJSON());
const textOf = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
const tabIds = (renderer: ReactTestRenderer): string[] =>
  renderer.root
    .findAll((node) => typeof node.props.testID === "string" && node.props.testID.startsWith("tv-details-tab-") && typeof node.type === "string")
    .map((node) => (node.props.testID as string).replace("tv-details-tab-", ""));

/** Let the screen's async loads (details, last-played episode, episode progress) land. */
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

/** Native views stand in as objects that record a focus request, so callback refs and focus guides can be checked. */
const render = async (mediaId: string): Promise<ReactTestRenderer> => {
  ctl.mediaId = mediaId;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<TvMediaDetailsScreen />, {
      createNodeMock: (element) => {
        const props: unknown = element.props;
        const testID = props && typeof props === "object" && "testID" in props && typeof props.testID === "string" ? props.testID : undefined;
        return { testID, requestTVFocus: () => ctl.focused.push(String(testID)) };
      },
    });
  });
  await settle();
  return renderer;
};

beforeAll(async () => {
  await initI18n("en");
  // The format sizes below are written for 1024-based units ("18.4 GB" for 18841.6 MiB); the TV's own 1000-based
  // reading is tested in detailsMedia.test.ts (STOR-UNIT-01).
  setStorageUnitBase(1024);
  console.info("[TvMediaDetailsScreen] storage unit base", getStorageUnitBase());
  ctl.details = { "show-1": show, "show-2": partialShow, "movie-1": movie };
  ctl.library = {
    getMediaDetails: async (id: string) => ctl.details[id] ?? null,
    getEpisodeResumeMap: async () => ctl.resume,
    awaitDatasetReady: async () => undefined,
    datasetStatus: { metadata: true },
    deleteMedia: async () => undefined,
  };
});

beforeEach(() => {
  ctl.focusListeners.length = 0;
  ctl.backListeners.length = 0;
  ctl.navigated.length = 0;
  ctl.openedUrls.length = 0;
  ctl.focused.length = 0;
  ctl.failingUrls.clear();
  ctl.youtubeAppInstalled = true;
  ctl.queriedUrls.length = 0;
  ctl.os = "android";
  ctl.lastPlayed = null;
  ctl.resume = {};
  ctl.warmed.length = 0;
  ctl.media = [];
  ctl.playlists = [];
  ctl.contains = {};
  ctl.toggled.length = 0;
  ctl.sections.length = 0;
});

describe("TV details Play button after the player (TV-DETAILS-RESUME-001)", () => {
  it("offers the episode just watched once the details regain focus", async () => {
    ctl.lastPlayed = "e1";
    ctl.resume = { e1: watched(5205) };
    const renderer = await render("show-1");
    console.info("[TV-DETAILS-RESUME-001] on mount: Play reads", JSON.stringify(playLabel(renderer)));
    expect(playLabel(renderer)).toBe("Resume S1E01");

    // The player played E2 past both thresholds (304 s of 13698 s: 15 s and 2%) and the remote's Back returned here.
    ctl.lastPlayed = "e2";
    ctl.resume = { e1: watched(5205), e2: watched(304) };
    bumpLibraryRevision();
    await act(async () => {
      ctl.focusListeners.slice().forEach((listener) => listener());
    });
    await settle();
    console.info("[TV-DETAILS-RESUME-001] back from the player: Play reads", JSON.stringify(playLabel(renderer)));
    expect(playLabel(renderer)).toBe("Resume S1E02");
  });

  it("offers Play, not Resume, for an episode just started below a threshold", async () => {
    ctl.lastPlayed = "e1";
    ctl.resume = { e1: watched(5205) };
    const renderer = await render("show-1");

    // E2 played from the start for 21 s: past 15 s but below 2% (274 s), so no resume point.
    ctl.lastPlayed = "e2";
    ctl.resume = { e1: watched(5205), e2: watched(21) };
    bumpLibraryRevision();
    await act(async () => {
      ctl.focusListeners.slice().forEach((listener) => listener());
    });
    await settle();
    console.info("[TV-DETAILS-RESUME-001] after 21 s of E2: Play reads", JSON.stringify(playLabel(renderer)));
    expect(playLabel(renderer)).toBe("Play S1E02");
  });

  // #934: opening the details starts the reads Play waits on, for the episode Play would start.
  it("@req PLAY-ABR-05[badger-tv] warms the play start for the episode Play offers", async () => {
    ctl.lastPlayed = "e2";
    ctl.resume = { e1: watched(5205), e2: watched(304) };
    const renderer = await render("show-1");
    console.info("[TV-DETAILS-RESUME-001] warmed on open", JSON.stringify(ctl.warmed), JSON.stringify(playLabel(renderer)));
    expect(playLabel(renderer)).toBe("Resume S1E02");
    expect(ctl.warmed).toEqual([{ token: null, mediaId: "show-1", episodeId: "e2" }]);
  });

  /** @req PERF-MOBILE-04[badger-tv] */
  it("reads nothing again when focus returns and the library did not change (#957)", async () => {
    ctl.lastPlayed = "e1";
    ctl.resume = { e1: watched(5205) };
    const reads = { resume: 0, details: 0 };
    const library = ctl.library as Record<string, unknown>;
    const { getEpisodeResumeMap, getMediaDetails } = library;
    library.getEpisodeResumeMap = async () => {
      reads.resume += 1;
      return ctl.resume;
    };
    library.getMediaDetails = async (id: string) => {
      reads.details += 1;
      return ctl.details[id] ?? null;
    };
    try {
      const renderer = await render("show-1");
      const afterMount = { ...reads };
      // A dialog, the player or another screen took the focus and handed it back; nothing was written meanwhile.
      ctl.resume = { e1: watched(5205), e2: watched(304) };
      await act(async () => {
        ctl.focusListeners.slice().forEach((listener) => listener());
      });
      await settle();
      console.info("[PERF-MOBILE-04] reads after mount", JSON.stringify(afterMount), "after focus", JSON.stringify(reads));
      expect(reads).toEqual(afterMount);
      expect(playLabel(renderer)).toBe("Resume S1E01");

      // The player wrote progress: the next focus reads it.
      bumpLibraryRevision();
      await act(async () => {
        ctl.focusListeners.slice().forEach((listener) => listener());
      });
      await settle();
      expect(reads.resume).toBe(afterMount.resume + 1);
    } finally {
      library.getEpisodeResumeMap = getEpisodeResumeMap;
      library.getMediaDetails = getMediaDetails;
    }
  });
});

/**
 * TV-DETAILS-LOAD-FAIL-001: a details read that throws left the page blank (the phone sheet showed nothing at all). The
 * shared details hook (`useMediaDetailsState`, phone and TV) turns it into "Could not load this title." with Retry, and
 * Retry reads again.
 *
 * @bugfix @regression-proof
 */
describe("TV details when the title cannot be read (TV-DETAILS-LOAD-FAIL-001)", () => {
  it("says it could not load, and Retry reads again", async () => {
    const library = ctl.library as { getMediaDetails: (id: string) => Promise<unknown> };
    const { getMediaDetails } = library;
    let calls = 0;
    library.getMediaDetails = async (id: string) => {
      calls += 1;
      if (calls === 1) throw new Error("db closed");
      return getMediaDetails(id);
    };
    try {
      const renderer = await render("show-1");
      console.info("[phase:failed]", JSON.stringify({ calls, failed: byId(renderer, "tv-details-failed").length }));
      expect(byId(renderer, "tv-details-failed")).toHaveLength(1);
      expect(allText(renderer)).toContain("Could not load this title.");
      await act(async () => {
        (one(renderer, "tv-details-retry").props.onPress as () => void)();
      });
      await settle();
      console.info("[phase:retried]", JSON.stringify({ calls, play: playLabel(renderer) }));
      expect(calls).toBe(2);
      expect(byId(renderer, "tv-details-failed")).toHaveLength(0);
      expect(byId(renderer, "tv-details-play")).toHaveLength(1);
    } finally {
      library.getMediaDetails = getMediaDetails;
    }
  });
});

/**
 * TV-DETAILS-FOCUS-001 (UX-TV-01: every control is reachable with the arrows). tvOS moves the focus only to what lies in the
 * pressed direction: from the season chip "S1" (at the left, under the poster), UP found nothing, because Play and Delete sit
 * right of the poster, and the focus stayed on S1 however often UP was pressed (Apple TV simulator, 2026-10-23, run 5: 23 UP
 * presses). The page top (poster and buttons, full width) is therefore a `TVFocusGuideView` with `autoFocus`: a move into it
 * lands on its last focused button (Play at first).
 *
 * @bugfix @regression-proof
 * @req UX-TV-01[badger-tv]
 */
describe("TV details hero focus (TV-DETAILS-FOCUS-001)", () => {
  it("puts Play and More in a TVFocusGuideView with autoFocus that also spans the poster", async () => {
    ctl.lastPlayed = "e1";
    const renderer = await render("show-1");
    const guides = renderer.root.findAll((node) => (node.type as unknown) === "TVFocusGuideView" && node.props.autoFocus === true);
    const hero = guides.find((guide) => guide.findAll((node) => node.props.testID === "tv-details-play").length > 0);
    console.info("[TV-DETAILS-FOCUS-001] autoFocus guides:", guides.length, "holding Play:", hero !== undefined);
    expect(hero).toBeDefined();
    expect(hero!.findAll((node) => node.props.testID === "tv-details-more").length).toBeGreaterThan(0);
    // The guide is the full top row, so it lies above the tabs and content at the left (under the poster).
    expect(
      hero!.findAll((node) => (node.type as unknown) === "View" && node.props.style?.width === TV_DETAILS_POSTER_WIDTH).length,
    ).toBeGreaterThan(0);
  });
});

/**
 * @test-id TV-DETAILS-TABS-001
 * @level component
 * @why The approved TV title page (Chris 2026-10-28, design demo screens 3 and 4): one Play button (the player asks
 *   "Resume at …" / "Start over"), Trailer playing full screen inside the app, tabs below the buttons that open as soon as the highlight
 *   lands on them, and DOWN/UP between buttons, open tab and the tab's content.
 * @req UX-TV-06[badger-tv]
 */
describe("TV title page tabs and buttons (TV-DETAILS-TABS-001)", () => {
  it("gives a movie Cast & crew and Versions and a show Episodes and Cast & crew, with no About tab", async () => {
    const movieRenderer = await render("movie-1");
    const showRenderer = await render("show-1");
    console.info("[TV-DETAILS-TABS-001] tabs", JSON.stringify({ movie: tabIds(movieRenderer), show: tabIds(showRenderer) }));
    expect(tabIds(movieRenderer)).toEqual(["cast", "versions"]);
    expect(tabIds(showRenderer)).toEqual(["episodes", "cast"]);
    expect(byId(movieRenderer, "tv-details-tabbody-cast")).toHaveLength(1);
    expect(byId(showRenderer, "tv-details-tabbody-episodes")).toHaveLength(1);
    expect(textOf(one(movieRenderer, "tv-details-tab-versions"))).toBe("Versions");
  });

  it("opens a tab when the highlight lands on it, without OK", async () => {
    const renderer = await render("movie-1");
    await act(async () => {
      one(renderer, "tv-details-tab-cast").props.onFocus();
    });
    console.info("[TV-DETAILS-TABS-001] after focus on Cast:", byId(renderer, "tv-details-tabbody-cast").length);
    expect(byId(renderer, "tv-details-tabbody-cast")).toHaveLength(1);
    expect(textOf(one(renderer, "tv-details-cast"))).toContain("Adam Scott");
    expect(one(renderer, "tv-details-tab-cast").props.accessibilityState).toEqual({ selected: true });
  });

  it("shows one Play button and never separate Resume / Start over buttons", async () => {
    const renderer = await render("movie-1");
    const text = allText(renderer);
    console.info("[TV-DETAILS-TABS-001] movie buttons", JSON.stringify(byId(renderer, "tv-details-play").map((n) => n.props.accessibilityLabel)));
    expect(byId(renderer, "tv-details-play")).toHaveLength(1);
    expect(playLabel(renderer)).toBe("Play");
    expect(text).not.toMatch(/start over|start-over/i);
    expect(text).not.toMatch(/tv-details-resume/);
    expect(text).toContain("40% watched · 77 min left");
    await act(async () => {
      one(renderer, "tv-details-play").props.onPress();
    });
    console.info("[TV-DETAILS-TABS-001] navigated", JSON.stringify(ctl.navigated));
    expect(ctl.navigated).toEqual([
      { name: "Player", params: { mediaId: "movie-1", episodeId: null, backdropPath: null, posterPath: null } },
    ]);
  });

  /**
   * Chris 2026-10-29 (TV testing): "the trailer button not working"; an Android TV box's YouTube app crashed on every
   * link and Chrome showed a cookie wall. Chris 2026-11-18: no Invidious and no referrer spoof on the TV; YouTube's embed
   * loaded from its real page never started on the Android TV emulator and ignored OK (2026-11-18), so the TV shows the
   * trailer's YouTube page as a QR code for a phone and opens nothing itself.
   */
  it("@req UX-TV-06 shows the trailer as Watch on YouTube with a QR code, opening nothing, and OK or Back returns to the page", async () => {
    const renderer = await render("movie-1");
    expect(byId(renderer, "tv-details-trailer-qr")).toHaveLength(0);
    const openQr = async () => {
      await act(async () => {
        one(renderer, "tv-details-trailer").props.onPress();
      });
      await settle();
      return one(renderer, "tv-details-trailer-qr");
    };

    const screen = await openQr();
    const qr = screen.findByType(QrCode);
    console.info("[TV-DETAILS-TABS-001] after Trailer", JSON.stringify({ opened: ctl.openedUrls, text: textOf(screen), qr: qr.props.payload }));
    expect(ctl.openedUrls).toEqual([]);
    expect(textOf(screen)).toContain("Watch on YouTube");
    expect(textOf(screen)).toContain("Scan with your phone to watch the trailer on YouTube.");
    expect(qr.props.payload).toBe("https://www.youtube.com/watch?v=abcDEF12345");
    // No YouTube player at all on the TV: nothing to load under a borrowed origin.
    expect(screen.findAll((node) => (node.type as unknown) === "YoutubePlayer")).toHaveLength(0);

    // The remote's OK lands on the overlay's own focus target (never the page behind) and closes it.
    const close = one(renderer, "tv-details-trailer-close");
    expect(close.props.hasTVPreferredFocus).toBe(true);
    ctl.focused.length = 0;
    await act(async () => {
      close.props.onPress();
    });
    console.info("[TV-DETAILS-TABS-001] after OK", JSON.stringify({ qr: byId(renderer, "tv-details-trailer-qr").length, focused: ctl.focused }));
    expect(byId(renderer, "tv-details-trailer-qr")).toHaveLength(0);
    expect(ctl.focused).toEqual(["tv-details-trailer"]);

    // The remote's Back closes the QR only (the newest Back listener is the QR's) and refocuses Trailer.
    await openQr();
    ctl.focused.length = 0;
    let handled = false;
    await act(async () => {
      handled = ctl.backListeners[ctl.backListeners.length - 1]!();
    });
    console.info("[TV-DETAILS-TABS-001] after Back", JSON.stringify({ handled, focused: ctl.focused, navigated: ctl.navigated }));
    expect(handled).toBe(true);
    expect(byId(renderer, "tv-details-trailer-qr")).toHaveLength(0);
    expect(ctl.focused).toEqual(["tv-details-trailer"]);
    expect(ctl.navigated).toEqual([]);
    expect(ctl.openedUrls).toEqual([]);

    const showRenderer = await render("show-1");
    expect(byId(showRenderer, "tv-details-trailer")).toHaveLength(0);
  });

  // Apple TV has no WebView: Chris 2026-10-29 "play it through the youtube app on apple tv" and "and for apple tv use the
  // youtube app and hide the button if there isn't one".
  it("on Apple TV hands the trailer to the YouTube app (youtube://watch/<id>), with no browser fallback", async () => {
    ctl.os = "ios";
    const renderer = await render("movie-1");
    await settle();
    console.info("[TV-DETAILS-TABS-001] tvOS queried", JSON.stringify(ctl.queriedUrls));
    expect(ctl.queriedUrls).toEqual(["youtube://"]);
    ctl.failingUrls.add("youtube://watch/abcDEF12345");
    await act(async () => {
      one(renderer, "tv-details-trailer").props.onPress();
    });
    await settle();
    console.info("[TV-DETAILS-TABS-001] tvOS opened", JSON.stringify(ctl.openedUrls));
    expect(ctl.openedUrls).toEqual(["youtube://watch/abcDEF12345"]);
    expect(textOf(renderer.root)).toContain("Could not open the trailer.");
    expect(byId(renderer, "tv-details-trailer-qr")).toHaveLength(0);
  });

  it("on Apple TV without the YouTube app there is no Trailer button; Android TV never asks", async () => {
    ctl.os = "ios";
    ctl.youtubeAppInstalled = false;
    const renderer = await render("movie-1");
    await settle();
    console.info("[TV-DETAILS-TABS-001] tvOS no app", JSON.stringify({ queried: ctl.queriedUrls, trailer: byId(renderer, "tv-details-trailer").length }));
    expect(byId(renderer, "tv-details-trailer")).toHaveLength(0);
    expect(byId(renderer, "tv-details-more")).toHaveLength(1);

    ctl.os = "android";
    ctl.queriedUrls.length = 0;
    const android = await render("movie-1");
    await settle();
    expect(byId(android, "tv-details-trailer")).toHaveLength(1);
    expect(ctl.queriedUrls).toEqual([]);
  });

  it("@req UX-TV-06 shows the year, runtime, rating and language on one line, the genres as pills and the synopsis", async () => {
    ctl.details["movie-genres"] = { ...movie, id: "movie-genres", genres: [18, 10749] } as MediaDetails;
    const renderer = await render("movie-genres");
    const meta = textOf(one(renderer, "tv-details-meta"));
    const genres = one(renderer, "tv-details-genres").findAll((node) => typeof node.props.testID === "string" && node.props.testID.startsWith("tv-details-genre-") && typeof node.type === "string");
    console.info("[TV-DETAILS-TABS-001] meta", JSON.stringify({ meta, genres: genres.map((node) => textOf(node)) }));
    expect(meta.startsWith("2005 · ")).toBe(true);
    expect(meta).toContain("7.8");
    expect(meta.endsWith("English")).toBe(true);
    expect(genres.map((node) => node.props.testID)).toEqual(["tv-details-genre-18", "tv-details-genre-10749"]);
    expect(genres.map((node) => textOf(node))).toEqual(["Drama", "Romance"]);
    expect(textOf(one(renderer, "tv-details-overview"))).toBe(movie.overview);
    expect(byId(renderer, "tv-details-about")).toHaveLength(0);
  });

  it("wires DOWN from the buttons to the open tab and DOWN from the tabs to the tab's first item", async () => {
    const renderer = await render("show-1");
    const guides = renderer.root.findAll((node) => (node.type as unknown) === "TVFocusGuideView" && Array.isArray(node.props.destinations));
    const targets = guides.map((guide) => (guide.props.destinations as Array<{ testID?: string }>).map((view) => view.testID));
    console.info("[TV-DETAILS-TABS-001] guide destinations", JSON.stringify(targets));
    // Tab body → the open season; the season row → the open season (UP from the episodes); the episode list → its first
    // row (DOWN from the seasons).
    expect(targets).toEqual([["tv-details-tab-episodes"], ["tv-details-season-1"], ["tv-details-season-1"], ["tv-details-episode-1-1"]]);

    await act(async () => {
      one(renderer, "tv-details-tab-cast").props.onFocus();
    });
    const after = renderer.root
      .findAll((node) => (node.type as unknown) === "TVFocusGuideView" && Array.isArray(node.props.destinations))
      .map((guide) => (guide.props.destinations as Array<{ testID?: string }>).map((view) => view.testID));
    console.info("[TV-DETAILS-TABS-001] guide destinations on Cast & crew", JSON.stringify(after));
    expect(after).toEqual([["tv-details-tab-cast"], ["tv-details-person-c1"]]);
  });
});

/**
 * @test-id TV-DETAILS-CREW-001
 * @level component
 * @why A title's details show its director and writers (LIB-CREW-01). On the TV they are the first faces of the
 *   Cast & crew tab, their job as role, so a title with crew and no cast still gets the tab.
 * @req LIB-CREW-01[badger-tv]
 */
describe("TV title page director and writers (TV-DETAILS-CREW-001)", () => {
  const crew = [
    { id: "k1", personId: "p9", tmdbId: null, name: "Joe Wright", job: "Director", profilePath: null },
    { id: "k2", personId: "p8", tmdbId: null, name: "Deborah Moggach", job: "Screenplay", profilePath: null },
    { id: "k3", personId: "p9", tmdbId: null, name: "Joe Wright", job: "Director", profilePath: null },
  ];

  it("lists the director then the writers before the cast, with their job as role", async () => {
    ctl.details["movie-crew"] = { ...movie, id: "movie-crew", crew } as MediaDetails;
    const renderer = await render("movie-crew");
    await act(async () => {
      one(renderer, "tv-details-tab-cast").props.onFocus();
    });
    const text = textOf(one(renderer, "tv-details-cast"));
    console.info("[TV-DETAILS-CREW-001] cast tab", JSON.stringify(text));
    expect(text).toContain("Director");
    expect(text).toContain("Writing");
    expect(text.split("Joe Wright")).toHaveLength(2);
    expect(text.indexOf("Joe Wright")).toBeLessThan(text.indexOf("Deborah Moggach"));
    expect(text.indexOf("Deborah Moggach")).toBeLessThan(text.indexOf("Adam Scott"));
  });

  it("keeps the Cast & crew tab when the title has crew and no cast", async () => {
    ctl.details["movie-crew-only"] = { ...movie, id: "movie-crew-only", cast: [], crew } as MediaDetails;
    const renderer = await render("movie-crew-only");
    expect(tabIds(renderer)).toEqual(["cast", "versions"]);
  });
});

/**
 * @test-id TV-DETAILS-TRACKS-001
 * @level component
 * @why Qualities and tracks follow the media model (Chris 2026-10-28): one video per movie and per episode in several
 *   qualities, the original first, in the movie's Versions tab (named so since the 2026-11-12 redesign, Chris 2026-11-12
 *   (chat)); a show has no qualities of its own and no Versions tab, each episode row
 *   shows its own, and its ⓘ button opens a side panel with that episode's qualities and tracks. Back closes the panel
 *   and gives the focus back to the ⓘ button.
 * @req UX-TV-07[badger-tv]
 */
describe("TV qualities and tracks per movie and per episode (TV-DETAILS-TRACKS-001)", () => {
  it("shows a movie's original quality with format and size, then its qualities, audio and subtitles", async () => {
    const renderer = await render("movie-1");
    await act(async () => {
      one(renderer, "tv-details-tab-versions").props.onFocus();
    });
    const block = textOf(one(renderer, "tv-details-versions"));
    console.info("[TV-DETAILS-TRACKS-001] movie block:", block);
    expect(block).toContain("2160p HDR");
    expect(block).toContain("HEVC · Dolby Vision · 18.4 GB");
    expect(block.indexOf("2160p HDR (original)")).toBeLessThan(block.indexOf("1080p"));
    expect(block.indexOf("1080p")).toBeLessThan(block.indexOf("720p"));
    expect(block).toContain("French 5.1");
    expect(block).toContain("English SDH");
  });

  // @req STOR-UNIT-02[badger-tv]
  it("[STOR-UNIT-02-TV-01] writes a version's size in the interface language: \"18,4 Go\" in French, \"18.4 GB\" in English", async () => {
    const sizes: Record<string, string> = {};
    try {
      for (const lng of ["fr", "en"] as const) {
        await changeLanguage(lng);
        const renderer = await render("movie-1");
        await act(async () => {
          one(renderer, "tv-details-tab-versions").props.onFocus();
        });
        sizes[lng] = textOf(one(renderer, "tv-details-versions"));
        console.info(`[STOR-UNIT-02-TV-01] ${lng} versions block:`, sizes[lng]);
        renderer.unmount();
      }
    } finally {
      await changeLanguage("en");
    }
    expect(sizes.fr).toContain("18,4 Go");
    expect(sizes.fr).not.toMatch(/\d GB|18\.4/);
    expect(sizes.en).toContain("18.4 GB");
  });

  it("shows each episode's own qualities on its row, and no qualities for the whole show", async () => {
    const renderer = await render("show-1");
    const e1 = textOf(one(renderer, "tv-details-episode-meta-1-1"));
    const e2 = textOf(one(renderer, "tv-details-episode-meta-1-2"));
    console.info("[TV-DETAILS-TRACKS-001] rows", JSON.stringify({ e1, e2 }));
    expect(e1).toBe("52 min · 1080p · 720p");
    expect(e2).toBe("52 min · 2160p HDR · 1080p");
    expect(tabIds(renderer)).not.toContain("tracks");
    expect(byId(renderer, "tv-details-tracks")).toHaveLength(0);
    expect(allText(renderer)).not.toMatch(/version|edition/i);
  });

  it("plays an episode with OK on its row", async () => {
    const renderer = await render("show-1");
    await act(async () => {
      one(renderer, "tv-details-episode-1-2").props.onPress();
    });
    console.info("[TV-DETAILS-TRACKS-001] navigated", JSON.stringify(ctl.navigated));
    expect(ctl.navigated).toEqual([{ name: "Player", params: { mediaId: "show-1", episodeId: "e2", backdropPath: null, posterPath: null } }]);
  });

  it("opens the episode side panel from ⓘ, and Back closes it and refocuses the ⓘ button", async () => {
    ctl.resume = { e2: watched(5205) };
    const renderer = await render("show-1");
    await act(async () => {
      one(renderer, "tv-details-episode-info-1-2").props.onPress();
    });
    const panel = one(renderer, "tv-details-episode-panel");
    const panelText = textOf(panel);
    console.info("[TV-DETAILS-TRACKS-001] panel:", panelText);
    expect(panelText).toContain("S1 · E2 · Episode 2");
    expect(panelText).toContain("Synopsis of episode 2.");
    expect(panelText).toContain("52 min · aired");
    expect(one(renderer, "tv-details-episode-panel-play").props.accessibilityLabel).toBe("Resume");
    const tracks = textOf(one(renderer, "tv-details-episode-panel-tracks"));
    expect(tracks).toContain("2160p HDR (original)");
    expect(tracks).toContain("English 5.1 Atmos");
    expect(tracks).toContain("French");
    expect(allText(renderer)).not.toMatch(/version|edition/i);

    console.info("[TV-DETAILS-TRACKS-001] back listeners:", ctl.backListeners.length);
    await act(async () => {
      expect(ctl.backListeners[ctl.backListeners.length - 1]!()).toBe(true);
    });
    console.info("[TV-DETAILS-TRACKS-001] after Back, focus requests:", JSON.stringify(ctl.focused));
    expect(byId(renderer, "tv-details-episode-panel")).toHaveLength(0);
    expect(ctl.focused).toEqual(["tv-details-episode-info-1-2"]);
  });

  it("starts the episode from the side panel's Play", async () => {
    const renderer = await render("show-1");
    await act(async () => {
      one(renderer, "tv-details-episode-info-1-1").props.onPress();
    });
    expect(one(renderer, "tv-details-episode-panel-play").props.accessibilityLabel).toBe("Play");
    await act(async () => {
      one(renderer, "tv-details-episode-panel-play").props.onPress();
    });
    console.info("[TV-DETAILS-TRACKS-001] navigated", JSON.stringify(ctl.navigated));
    expect(ctl.navigated).toEqual([{ name: "Player", params: { mediaId: "show-1", episodeId: "e1", backdropPath: null, posterPath: null } }]);
  });
});

/** Flattened style of a node: what the TV draws. */
const flatStyle = (node: ReactTestInstance): Record<string, unknown> =>
  Object.assign({}, ...[node.props.style].flat(Infinity).filter(Boolean)) as Record<string, unknown>;
const greyed = (renderer: ReactTestRenderer, testID: string): boolean => {
  const style = flatStyle(one(renderer, testID));
  return style.opacity === 0.4 && JSON.stringify(style.filter) === JSON.stringify([{ grayscale: 1 }]);
};
const seasonIds = (renderer: ReactTestRenderer): string[] =>
  renderer.root
    .findAll((node) => typeof node.props.testID === "string" && /^tv-details-season-\d+$/.test(node.props.testID) && typeof node.type === "string")
    .map((node) => node.props.testID as string);
const episodeIds = (renderer: ReactTestRenderer): string[] =>
  renderer.root
    .findAll((node) => typeof node.props.testID === "string" && /^tv-details-episode-\d+-\d+$/.test(node.props.testID) && typeof node.type === "string")
    .map((node) => node.props.testID as string);

/**
 * @test-id TV-DETAILS-SEASONS-001
 * @level component
 * @why Chris 2026-10-28: a TV show page has a seasons menu, then the season's episodes, like the desktop app, and
 *   seasons and episodes the library has no file for are greyed out the same way (desktop `opacity-40 grayscale`).
 *   As on desktop they stay reachable: a greyed season still opens its (greyed) episodes, and OK on a greyed episode
 *   shows its details instead of starting the player.
 * @req UX-TV-08[badger-tv]
 */
describe("TV seasons then episodes menus (TV-DETAILS-SEASONS-001)", () => {
  it("@req UX-TV-08 lists every season, greys the ones without a file, and opens on the first season with a file", async () => {
    const renderer = await render("show-2");
    console.info("[UX-TV-08] seasons", JSON.stringify(seasonIds(renderer)), "episodes", JSON.stringify(episodeIds(renderer)));
    expect(seasonIds(renderer)).toEqual(["tv-details-season-0", "tv-details-season-1", "tv-details-season-2", "tv-details-season-3"]);
    expect(one(renderer, "tv-details-season-1").props.accessibilityState).toEqual({ selected: true });
    expect(episodeIds(renderer)).toEqual(["tv-details-episode-1-1", "tv-details-episode-1-2", "tv-details-episode-1-3"]);
    expect(greyed(renderer, "tv-details-season-content-1")).toBe(false);
    for (const number of [0, 2, 3]) expect(greyed(renderer, `tv-details-season-content-${number}`)).toBe(true);
    expect(textOf(one(renderer, "tv-details-season-1"))).toContain("3 episodes");
    expect(textOf(one(renderer, "tv-details-season-1"))).toContain("Available");
    expect(textOf(one(renderer, "tv-details-season-2"))).toContain("Missing files");
    // Greyed seasons stay focusable, as desktop keeps them clickable.
    expect(one(renderer, "tv-details-season-2").props.disabled).toBeUndefined();
  });

  it("@req UX-TV-08 greys the episodes without a file and keeps the others normal", async () => {
    const renderer = await render("show-2");
    const states = ["1-1", "1-2", "1-3"].map((key) => ({
      key,
      still: greyed(renderer, `tv-details-episode-still-${key}`),
      text: greyed(renderer, `tv-details-episode-text-${key}`),
    }));
    console.info("[UX-TV-08] episode greying", JSON.stringify(states));
    expect(states).toEqual([
      { key: "1-1", still: false, text: false },
      { key: "1-2", still: false, text: false },
      { key: "1-3", still: true, text: true },
    ]);
    // The focus ring sits on the row itself, which is never dimmed.
    expect(flatStyle(one(renderer, "tv-details-episode-1-3")).opacity).toBeUndefined();
    expect(one(renderer, "tv-details-episode-1-3").props.disabled).toBeUndefined();
  });

  it("@req UX-TV-08 opens a season's episodes as soon as the highlight lands on it", async () => {
    const renderer = await render("show-2");
    await act(async () => {
      one(renderer, "tv-details-season-2").props.onFocus();
    });
    console.info("[UX-TV-08] after focus on season 2", JSON.stringify(episodeIds(renderer)));
    expect(episodeIds(renderer)).toEqual(["tv-details-episode-2-1", "tv-details-episode-2-2"]);
    expect(greyed(renderer, "tv-details-episode-text-2-1")).toBe(true);
    expect(greyed(renderer, "tv-details-episode-text-2-2")).toBe(true);
    expect(one(renderer, "tv-details-season-2").props.accessibilityState).toEqual({ selected: true });
    expect(one(renderer, "tv-details-season-1").props.accessibilityState).toEqual({ selected: false });
    const guides = renderer.root.findAll((node) => (node.type as unknown) === "TVFocusGuideView" && Array.isArray(node.props.destinations));
    const targets = guides.map((guide) => (guide.props.destinations as Array<{ testID?: string }>).map((view) => view.testID));
    console.info("[UX-TV-08] guide destinations on season 2", JSON.stringify(targets));
    expect(targets).toEqual([["tv-details-tab-episodes"], ["tv-details-season-2"], ["tv-details-season-2"], ["tv-details-episode-2-1"]]);

    await act(async () => {
      one(renderer, "tv-details-season-1").props.onPress();
    });
    expect(episodeIds(renderer)).toEqual(["tv-details-episode-1-1", "tv-details-episode-1-2", "tv-details-episode-1-3"]);
  });

  it("@req UX-TV-08 opens on the season being resumed, even one without files", async () => {
    ctl.lastPlayed = "f1";
    const renderer = await render("show-2");
    console.info("[UX-TV-08] resumed season", JSON.stringify(seasonIds(renderer).filter((id) => one(renderer, id).props.accessibilityState?.selected)));
    expect(one(renderer, "tv-details-season-2").props.accessibilityState).toEqual({ selected: true });
    expect(episodeIds(renderer)).toEqual(["tv-details-episode-2-1", "tv-details-episode-2-2"]);
  });

  it("@req UX-TV-08 shows a greyed episode's details on OK, without Play, and never starts the player", async () => {
    const renderer = await render("show-2");
    await act(async () => {
      one(renderer, "tv-details-episode-1-3").props.onPress();
    });
    console.info("[UX-TV-08] OK on greyed E3: navigated", JSON.stringify(ctl.navigated), "panel", byId(renderer, "tv-details-episode-panel").length);
    expect(ctl.navigated).toEqual([]);
    expect(textOf(one(renderer, "tv-details-episode-panel"))).toContain("S1 · E3 · Episode 3");
    expect(byId(renderer, "tv-details-episode-panel-play")).toHaveLength(0);
    expect(textOf(one(renderer, "tv-details-episode-panel-close"))).toBe("Close");
    await act(async () => {
      one(renderer, "tv-details-episode-panel-close").props.onPress();
    });
    expect(byId(renderer, "tv-details-episode-panel")).toHaveLength(0);

    // An episode with a file still plays on OK.
    await act(async () => {
      one(renderer, "tv-details-episode-1-1").props.onPress();
    });
    expect(ctl.navigated).toEqual([{ name: "Player", params: { mediaId: "show-2", episodeId: "e1", backdropPath: null, posterPath: null } }]);
  });
});

describe("TV title page synopsis language (LIB-LANG-01)", () => {
  /**
   * @req LIB-LANG-01
   * @bugfix german-synopsis-under-english-ui
   * @regression-proof
   * "Anders als die Andern" (1919) added in "auto" title language stores its German synopsis; with English selected
   * the TV and phone pages showed that German text. They now show TMDB's synopsis in the interface language.
   */
  it("shows the synopsis in the interface language instead of the stored German one", async () => {
    ctl.token = "session-token";
    ctl.tmdbOverviews = { de: "Ein Geiger wird erpresst.", en: "A violinist is blackmailed." };
    ctl.askedOverviews = [];
    ctl.details["movie-de"] = { ...movie, id: "movie-de", tmdbId: 28055, originalLanguage: "de", overview: "Ein Geiger wird erpresst." };
    try {
      const renderer = await render("movie-de");
      console.info("[tv-details:synopsis] asked", JSON.stringify(ctl.askedOverviews));
      const text = allText(renderer);
      expect(ctl.askedOverviews).toEqual(["movie:28055:en"]);
      expect(text).toContain("A violinist is blackmailed.");
      expect(text).not.toContain("Ein Geiger wird erpresst.");
    } finally {
      ctl.token = null;
    }
  });
});

describe("TV episode synopsis language (LIB-LANG-01)", () => {
  /**
   * @req LIB-LANG-01
   * @bugfix german-episode-synopsis-under-english-ui
   * @regression-proof
   * A show added in "auto" title language stores its episodes' German synopses; with English selected the episode rows
   * showed that German text. They now show TMDB's English synopsis, and the stored one only where TMDB has none.
   */
  it("shows each episode's synopsis in the interface language, the stored one where TMDB has none", async () => {
    ctl.token = "session-token";
    ctl.askedEpisodes = [];
    ctl.tmdbEpisodes = { en: [{ seasonNumber: 1, episodeNumber: 1, name: "The Beginning", overview: "It all begins." }, { seasonNumber: 1, episodeNumber: 2, name: "Episode 2", overview: null }] };
    ctl.details["show-de"] = {
      ...show,
      id: "show-de",
      tmdbId: 99001,
      originalLanguage: "de",
      episodes: [
        { ...episode("e1", 1), name: "Der Anfang", overview: "Alles beginnt." },
        { ...episode("e2", 2), name: "Folge 2", overview: "Nur auf Deutsch." },
      ],
    } as MediaDetails;
    try {
      const renderer = await render("show-de");
      const text = allText(renderer);
      console.info("[tv-details:episode-synopsis] asked", JSON.stringify(ctl.askedEpisodes));
      expect(ctl.askedEpisodes).toEqual(["99001:en"]);
      expect(text).toContain("It all begins.");
      expect(text).not.toContain("Alles beginnt.");
      expect(text).toContain("Nur auf Deutsch.");
    } finally {
      ctl.token = null;
    }
  });
});

describe("TV title page Back button (TV-BADGER-DETAILS-001)", () => {
  it.each([
    ["library", "Back to Library"],
    ["search", "Back to Search"],
    ["home", "Back to Home"],
  ] as const)("@req UX-TV-06 opened from %s, its focusable Back button reads %j and returns there", async (section, label) => {
    setCurrentTvSection(section);
    ctl.wentBack = 0;
    const renderer = await render("movie-1");
    // The page keeps the section it was opened from, even if the shell under it changes later.
    setCurrentTvSection("settings");
    const back = renderer.root.find((node) => node.props.testID === "tv-details-back" && String(node.type) === "TvFocusable");
    console.info("[TV-BADGER-DETAILS-001] back", JSON.stringify({ section, label: back.props.accessibilityLabel }));
    expect(back.props.accessibilityLabel).toBe(label);
    // In its own full-width guide above the top row, so UP from Play lands on it.
    expect(back.parent?.type).toBe("TVFocusGuideView");
    expect(back.parent?.props.autoFocus).toBe(true);
    await act(async () => back.props.onPress());
    expect(ctl.wentBack).toBe(1);
    setCurrentTvSection("home");
  });

  it("@req UX-TV-06 has no audio or subtitle buttons: those choices live in the player", async () => {
    const renderer = await render("movie-1");
    const labels = renderer.root
      .findAll((node) => String(node.type) === "TvFocusable")
      .map((node) => String(node.props.accessibilityLabel ?? node.props.testID ?? ""));
    console.info("[TV-BADGER-DETAILS-001] focusables", JSON.stringify(labels));
    expect(labels.join(" ")).not.toMatch(/audio|subtitle/i);
  });
});

/**
 * @test-id TV-DETAILS-REDESIGN-001
 * @level component
 * @why The redesigned title page (Chris 2026-11-12 (chat), mockup `tv-detail`): the top bar of the shell, version chips
 *   above the title with the one that plays in amber, Play first and focused, then Trailer, Playlist and "…" for Delete;
 *   a Playlist window that adds the title to a playlist or takes it out; and a More like this tab of library titles.
 * @req UX-TV-06[badger-tv]
 * @req UX-TV-40[badger-tv]
 * @req UX-TV-41[badger-tv]
 */
describe("TV title page redesign (TV-DETAILS-REDESIGN-001)", () => {
  const row = (id: string, type: "movie" | "tv", genres: number[], rating: number) =>
    ({ id, type, genres, rating, addedAt: "2026-10-01T00:00:00Z", title: id, year: "2010", posterPath: null, progressPct: 0 }) as unknown;

  it("@req UX-TV-06 starts the remote on Play, then Trailer, Playlist and the round … button in that order", async () => {
    const renderer = await render("movie-1");
    const actions = renderer.root
      .findAll((node) => typeof node.type === "string" && ["tv-details-play", "tv-details-trailer", "tv-details-playlist", "tv-details-more"].includes(node.props.testID))
      .map((node) => node.props.testID);
    console.info("[TV-DETAILS-REDESIGN-001] buttons", JSON.stringify(actions));
    expect(actions).toEqual(["tv-details-play", "tv-details-trailer", "tv-details-playlist", "tv-details-more"]);
    expect(one(renderer, "tv-details-play").props.hasTVPreferredFocus).toBe(true);
    expect(one(renderer, "tv-details-playlist").props.hasTVPreferredFocus).toBe(false);
  });

  it("@req UX-TV-06 shows the movie's qualities as chips above the title, the one that plays first", async () => {
    const renderer = await render("movie-1");
    const chips = one(renderer, "tv-details-versions-chips").findAll(
      (node) => typeof node.type === "string" && typeof node.props.testID === "string" && node.props.testID.startsWith("tv-details-chip-"),
    );
    console.info("[TV-DETAILS-REDESIGN-001] chips", JSON.stringify(chips.map((node) => textOf(node))));
    expect(chips.map((node) => textOf(node))).toEqual(["2160p HDR", "1080p", "720p"]);
    const amber = chips.map((node) => (node.props.style as unknown[]).filter(Boolean).length > 1);
    expect(amber).toEqual([true, false, false]);
    const show = await render("show-1");
    expect(byId(show, "tv-details-versions-chips")).toHaveLength(0);
  });

  it("@req UX-TV-41 opens Delete from the … button", async () => {
    const renderer = await render("movie-1");
    await act(async () => {
      one(renderer, "tv-details-more").props.onPress();
    });
    const dialog = renderer.root.find((node) => (node.type as unknown) === "TvListDialog" && node.props.testID === "tv-details-more-dialog");
    const items = dialog.props.items as Array<{ testID: string; onPress: () => void }>;
    expect(items.map((item) => item.testID)).toEqual(["tv-details-delete"]);
    await act(async () => {
      items[0]!.onPress();
    });
    expect(renderer.root.findAll((node) => (node.type as unknown) === "TvListDialog" && node.props.testID === "tv-details-delete-dialog")).toHaveLength(1);
  });

  it("@req UX-TV-41 lists every playlist with the ones holding the title selected, and OK switches one and stays open", async () => {
    ctl.playlists = [
      { id: "fav", name: "Favorites" },
      { id: "watch", name: "Watchlist" },
      { id: "p3", name: "Sunday films" },
    ];
    ctl.contains = { fav: true };
    const renderer = await render("movie-1");
    await act(async () => {
      one(renderer, "tv-details-playlist").props.onPress();
    });
    const dialog = () => renderer.root.find((node) => (node.type as unknown) === "TvListDialog" && node.props.testID === "tv-details-playlist-dialog");
    const items = dialog().props.items as Array<{ testID: string; label: string; selected: boolean; onPress: () => void }>;
    console.info("[TV-DETAILS-REDESIGN-001] playlists", JSON.stringify(items.map(({ testID, selected }) => ({ testID, selected }))));
    expect(items.map((item) => [item.label, item.selected])).toEqual([
      ["Favorites", true],
      ["Watchlist", false],
      ["Sunday films", false],
    ]);
    await act(async () => {
      items[2]!.onPress();
    });
    expect(ctl.toggled).toEqual(["p3"]);
    expect(dialog().props.initialFocusKey).toBe("p3");
  });

  it("@req UX-TV-41 says there are no playlists yet when the profile has none", async () => {
    const renderer = await render("movie-1");
    await act(async () => {
      one(renderer, "tv-details-playlist").props.onPress();
    });
    const dialog = renderer.root.find((node) => (node.type as unknown) === "TvListDialog" && node.props.testID === "tv-details-playlist-dialog");
    expect(dialog.props.items).toEqual([]);
    expect(dialog.props.message).toBe("No playlists yet.");
  });

  it("@req UX-TV-40 adds More like this with library titles of the same kind sharing a genre, and OK opens one", async () => {
    ctl.details["movie-similar"] = { ...movie, id: "movie-similar", genres: [18, 10749] } as MediaDetails;
    ctl.media = [row("m-a", "movie", [18], 6), row("m-b", "movie", [18, 10749], 5), row("s-a", "tv", [18], 9), row("m-c", "movie", [35], 9)];
    const renderer = await render("movie-similar");
    expect(tabIds(renderer)).toEqual(["cast", "versions", "similar"]);
    await act(async () => {
      one(renderer, "tv-details-tab-similar").props.onFocus();
    });
    const cards = one(renderer, "tv-details-similar").findAll((node) => (node.type as unknown) === "TvPosterCard");
    console.info("[TV-DETAILS-REDESIGN-001] similar", JSON.stringify(cards.map((card) => card.props.item.id)));
    expect(cards.map((card) => card.props.item.id)).toEqual(["m-b", "m-a"]);
    // DOWN from the tabs lands in the row: the cards sit in a focus guide that remembers the last one.
    expect(
      renderer.root.findAll((node) => (node.type as unknown) === "TVFocusGuideView" && node.props.autoFocus === true && node.findAll((n) => n.props.testID === "tv-details-similar").length > 0),
    ).not.toHaveLength(0);
    await act(async () => {
      cards[0]!.props.onPress("m-b");
    });
    expect(ctl.navigated).toEqual([{ name: "push:MediaDetails", params: { mediaId: "m-b" } }]);
  });

  it("@req UX-TV-40 has no More like this tab when no other title shares a genre", async () => {
    ctl.details["show-similar"] = { ...show, id: "show-similar", genres: [18] } as MediaDetails;
    ctl.media = [row("m-a", "movie", [18], 6)];
    const renderer = await render("show-similar");
    expect(tabIds(renderer)).toEqual(["episodes", "cast"]);
  });

  it("@req UX-TV-06 switches the shell to another top bar tab and closes the page onto it", async () => {
    setCurrentTvSection("library");
    const renderer = await render("movie-1");
    const bar = renderer.root.find((node) => (node.type as unknown) === "TvTopBar");
    expect(bar.props.active).toBe("library");
    const before = ctl.wentBack;
    await act(async () => {
      bar.props.onSelect("search");
    });
    expect(ctl.sections).toEqual(["search"]);
    expect(ctl.wentBack).toBe(before + 1);
    await act(async () => {
      bar.props.onSelect("library");
    });
    expect(ctl.sections).toEqual(["search"]);
    expect(ctl.wentBack).toBe(before + 2);
  });
});

describe("TV title page backdrop (TV-DETAILS-BACKDROP-001)", () => {
  // On the Android TV emulator (2026-11-13) the backdrop never showed: the picture had a mask and sat in a group with
  // another mask, and react-native-svg on Android draws nothing for that. The Svg also spanned the whole width, its own
  // width prop overriding the 72 % in its style.
  it("@req UX-TV-06 draws the picture at 30 % under one mask on the right 72 %, with no mask inside another", async () => {
    ctl.details["movie-bd"] = { ...movie, id: "movie-bd", backdropPath: "/bd.jpg" };
    ctl.backdropUrl = "file:///cache/metadata-images/bd";
    try {
      const renderer = await render("movie-bd");
      const box = one(renderer, "tv-details-backdrop");
      const images = box.findAll((node) => String(node.type) === "SvgImage");
      const masks = box.findAll((node) => String(node.type) === "Mask");
      const masked = box.findAll((node) => typeof node.type === "string" && node.props.mask !== undefined);
      console.info(
        "[TV-DETAILS-BACKDROP-001] backdrop",
        JSON.stringify({ style: box.props.style, images: images.map((n) => n.props.href), masks: masks.map((n) => n.props.id), masked: masked.map((n) => n.type) }),
      );
      expect(box.type).toBe("View");
      expect(box.props.style).toMatchObject({ position: "absolute", top: 0, right: 0, width: "72%" });
      expect(images).toHaveLength(1);
      expect(images[0].props.href).toEqual({ uri: "file:///cache/metadata-images/bd" });
      expect(images[0].props.opacity).toBe(0.3);
      expect(masks).toHaveLength(1);
      expect(masks[0].findAll((node) => String(node.type) === "Rect")).toHaveLength(2);
      // Exactly one masked element, the picture itself, using the one mask.
      expect(masked).toEqual([images[0]]);
      expect(images[0].props.mask).toBe(`url(#${String(masks[0].props.id)})`);
    } finally {
      ctl.backdropUrl = null;
      delete ctl.details["movie-bd"];
    }
  });

  // DETAILS-HERO-BLANK-001 (@bugfix @regression-proof): react-native-svg on iOS drew nothing of a picture under a mask in
  // the default objectBoundingBox units (the phone hero was blank on the iOS 26 simulator); in user space it draws.
  it("@req UX-TV-06 masks the picture with a mask spanning the whole backdrop in user space", async () => {
    ctl.details["movie-bd"] = { ...movie, id: "movie-bd", backdropPath: "/bd.jpg" };
    ctl.backdropUrl = "file:///cache/metadata-images/bd";
    try {
      const renderer = await render("movie-bd");
      const masks = one(renderer, "tv-details-backdrop").findAll((node) => String(node.type) === "Mask");
      expect(masks).toHaveLength(1);
      expect(masks[0].props).toMatchObject({ x: "0", y: "0", width: "100%", height: "100%", maskUnits: "userSpaceOnUse" });
    } finally {
      ctl.backdropUrl = null;
      delete ctl.details["movie-bd"];
    }
  });

  it("draws no backdrop while the title has none", async () => {
    const renderer = await render("movie-1");
    expect(renderer.root.findAll((node) => node.props.testID === "tv-details-backdrop")).toHaveLength(0);
  });
});
