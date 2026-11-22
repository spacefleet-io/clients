/**
 * @test-id MOBILE-SHELL-OFFLINE-CONTENT-001
 * @level unit
 * @req OFFL-MANAGE-01[badger-mobile,parrot]
 * @why Settings › "Manage offline content" on the phones (Chris 2026-11-21, draft A): one compact row with the total
 *   saved offline and "Remove all" (behind a confirmation), each saved item in up to three levels told apart by tint
 *   (never indented), a bin on every row that removes it with everything inside, and an empty state that says how to
 *   keep something. The real screen runs through i18next with the English texts and the shared grouping; the app's
 *   removing is replaced.
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import i18next, { type i18n as I18n } from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { groupBadgerOffline, groupParrotOfflineTree, type OfflineManageList } from "@space/shared/offlineManage";
import en from "../src/i18n/en.json";

type AlertButton = { text: string; style?: string; onPress?: () => void };

const h = vi.hoisted(() => ({
  i18n: null as I18n | null,
  alert: vi.fn<(title: string, body: string, buttons: AlertButton[]) => void>(),
}));

vi.mock("react-native", async () => {
  // vi.mock is hoisted above the static imports, so the factory loads react itself.
  const { createElement: el, Fragment } = await import("react");
  type FlatListProps<T> = {
    data: T[];
    renderItem: (info: { item: T }) => ReactNode;
    keyExtractor: (item: T) => string;
    ListHeaderComponent?: ReactNode;
  };
  const FlatList = <T,>({ data, renderItem, keyExtractor, ListHeaderComponent }: FlatListProps<T>) =>
    el(
      "FlatList",
      null,
      ListHeaderComponent,
      data.map((item) => el(Fragment, { key: keyExtractor(item) }, renderItem({ item })))
    );
  return {
    ActivityIndicator: "ActivityIndicator",
    Alert: { alert: (...a: Parameters<typeof h.alert>) => h.alert(...a) },
    FlatList,
    Image: "Image",
    Pressable: "Pressable",
    Text: "Text",
    View: "View",
    StyleSheet: { create: <T,>(s: T) => s, hairlineWidth: 1 },
  };
});
vi.mock("lucide-react-native", () => ({ ArrowLeft: "ArrowLeft", ChevronDown: "ChevronDown", ChevronRight: "ChevronRight", Trash2: "Trash2" }));
vi.mock("../src/theme", () => ({
  useMobileShellTheme: () => ({
    colors: { accent: "#ffb357", accentSoft: "#4a3a22", text: "#fff", textMuted: "#aaa", surface: "#111", surfaceRaised: "#222", border: "#333", danger: "#f00" },
  }),
}));
vi.mock("../src/i18n", () => ({ getCurrentLanguage: () => "en", useTranslation: () => ({ t: h.i18n!.t.bind(h.i18n) }) }));
vi.mock("../src/logger", () => ({ scopeLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

import { MobileOfflineContent, type MobileOfflineContentProps } from "../src/components/mobile-offline-content";

const SUITE = "MOBILE-SHELL-OFFLINE-CONTENT-001";
// Sizes show in decimal units (formatLocalizedStorage), so the fixtures use decimal megabytes.
const MB = 1000 * 1000;

const byTestId = (tree: ReactTestRenderer, id: string) => tree.root.findAll((n) => n.props.testID === id && typeof n.type === "string");
const textOf = (tree: ReactTestRenderer, id: string) => [byTestId(tree, id)[0]!.props.children].flat().join("");
const press = async (tree: ReactTestRenderer, id: string) =>
  act(async () => {
    byTestId(tree, id)[0]!.props.onPress();
  });

const badgerList = (): OfflineManageList =>
  groupBadgerOffline(
    [
      { mediaId: "m-film", fileId: "f-film", totalBytes: 700 * MB },
      { mediaId: "m-show", fileId: "f-e1", totalBytes: 300 * MB },
      { mediaId: "m-show", fileId: "f-e2", totalBytes: 200 * MB },
    ],
    (mediaId) =>
      mediaId === "m-film"
        ? { type: "movie", title: "Arrival", posterPath: null, files: [{ id: "f-film", season: null, episode: null }] }
        : mediaId === "m-show"
          ? {
              type: "tv",
              title: "Severance",
              posterPath: null,
              files: [
                { id: "f-e1", season: 1, episode: 1 },
                { id: "f-e2", season: 1, episode: 2 },
              ],
              seasons: [{ seasonNumber: 1, name: "Season 1", posterPath: null }],
              episodes: [
                { seasonNumber: 1, episodeNumber: 1, name: "Good News About Hell" },
                { seasonNumber: 1, episodeNumber: 2, name: "Half Loop" },
              ],
            }
          : null
  );

const render = async (props: Partial<MobileOfflineContentProps> & Pick<MobileOfflineContentProps, "list">) => {
  let tree!: ReactTestRenderer;
  const full: MobileOfflineContentProps = {
    app: "badger",
    onRemove: vi.fn().mockResolvedValue(undefined),
    onRemoveAll: vi.fn().mockResolvedValue(undefined),
    onBack: vi.fn(),
    ...props,
  };
  await act(async () => {
    tree = create(createElement(MobileOfflineContent, full));
  });
  return { tree, props: full };
};

describe("phone Manage offline content (OFFL-MANAGE-01)", () => {
  beforeAll(async () => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const i18n = i18next.createInstance();
    await i18n.init({ lng: "en", interpolation: { escapeValue: false }, resources: { en: { translation: en } } });
    h.i18n = i18n;
  });
  beforeEach(() => {
    h.alert.mockReset();
  });

  it("shows the total at the top and each film or show with its size; a show opens to seasons then episodes", async () => {
    const list = badgerList();
    console.info(`[${SUITE}] grouped`, JSON.stringify(list.rows.map((r) => [r.key, r.bytes, r.children.length])));
    const { tree } = await render({ list });
    const total = textOf(tree, "offline-content-total");
    console.info(`[${SUITE}] total`, total);
    expect(total).toMatch(/1\.2 GB|1,2 GB|1200 MB/);
    expect(textOf(tree, "offline-title-movie:m-film")).toBe("Arrival");
    expect(textOf(tree, "offline-detail-movie:m-film")).toMatch(/700 MB/);
    expect(textOf(tree, "offline-title-show:m-show")).toBe("Severance");
    expect(byTestId(tree, "offline-row-season:m-show:1")).toHaveLength(0);

    await press(tree, "offline-toggle-show:m-show");
    expect(byTestId(tree, "offline-row-season:m-show:1")).toHaveLength(1);
    await press(tree, "offline-toggle-season:m-show:1");
    const episode = textOf(tree, "offline-detail-episode:f-e2");
    console.info(`[${SUITE}] episode detail`, episode);
    expect(textOf(tree, "offline-title-episode:f-e2")).toBe("Half Loop");
    expect(episode).toMatch(/^S1 E2 · 200 MB$/);
    expect(byTestId(tree, "offline-content-empty")).toHaveLength(0);
  });

  it("removes one row through the app, and says so when it fails", async () => {
    const list = badgerList();
    const onRemove = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disk busy"));
    const { tree } = await render({ list, onRemove });
    await press(tree, "offline-remove-movie:m-film");
    console.info(`[${SUITE}] removed row`, onRemove.mock.calls[0]?.[0]?.key);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove.mock.calls[0]![0]).toMatchObject({ kind: "movie", id: "m-film", fileId: "f-film" });
    expect(byTestId(tree, "offline-content-error")).toHaveLength(0);

    await press(tree, "offline-remove-show:m-show");
    console.info(`[${SUITE}] failed remove shows error`, byTestId(tree, "offline-content-error").length);
    expect(textOf(tree, "offline-content-error")).toBe(en.offlineContent.removeFailed);
  });

  it("removes everything only once the confirmation is accepted", async () => {
    const onRemoveAll = vi.fn().mockResolvedValue(undefined);
    const { tree } = await render({ list: badgerList(), onRemoveAll });
    await press(tree, "offline-content-remove-all");
    const [title, body, buttons] = h.alert.mock.calls[0]!;
    console.info(`[${SUITE}] confirm`, title, body, buttons.map((b) => `${b.text}/${b.style}`));
    expect(title).toBe(en.offlineContent.badger.confirmTitle);
    expect(body).toBe(en.offlineContent.badger.confirmBody);
    expect(onRemoveAll).not.toHaveBeenCalled();

    buttons.find((b) => b.style === "cancel")?.onPress?.();
    expect(onRemoveAll).not.toHaveBeenCalled();
    await act(async () => {
      buttons.find((b) => b.style === "destructive")!.onPress!();
    });
    expect(onRemoveAll).toHaveBeenCalledTimes(1);
  });

  it("Parrot: artist › album › song told apart by tint, a bin on every row, artwork on artists and albums", async () => {
    const sizes: Record<string, number> = { s1: 4 * MB, s2: 6 * MB, s3: 5 * MB };
    const song = (trackId: string, fileId: string, title: string | null, albumId: string, number: number) => ({
      trackId,
      fileId,
      title,
      albumId,
      artistId: "ar1",
      artistName: "Massive Attack",
      disc: 1,
      number,
    });
    const list = groupParrotOfflineTree({
      songs: [song("t1", "s1", "Safe from Harm", "al1", 1), song("t2", "s2", "Unfinished Sympathy", "al1", 6), song("t3", "s3", null, "al2", 1)],
      playlists: [],
      albumOf: (albumId) => (albumId === "al1" ? { title: "Blue Lines", artistId: "ar1", artistName: "Massive Attack", imagePath: "cover-al1" } : null),
      bytesOf: (fileId) => sizes[fileId] ?? 0,
    });
    const renderArtwork = vi.fn((row: { key: string }, size: number) => createElement("Art", { testID: `art-${row.key}`, size }));
    const onRemove = vi.fn().mockResolvedValue(undefined);
    const { tree } = await render({ app: "parrot", list, renderArtwork, onRemove });
    await press(tree, "offline-toggle-artist:ar1");
    await press(tree, "offline-toggle-album:al1");
    const rowStyle = (key: string) => Object.assign({}, ...[byTestId(tree, `offline-row-${key}`)[0]!.props.style].flat(Infinity).filter(Boolean));
    const levels = ["artist:ar1", "album:al1", "song:t1"].map((key) => ({ key, style: rowStyle(key) }));
    console.info(`[${SUITE}] parrot levels`, JSON.stringify(levels));
    expect(levels.map((level) => level.style.backgroundColor)).toEqual(["#111", "#222", "#4a3a22"]);
    for (const level of levels) expect(level.style.marginLeft).toBeUndefined();
    expect(textOf(tree, "offline-detail-artist:ar1")).toBe("15 MB");
    expect(textOf(tree, "offline-detail-album:al1")).toBe("10 MB");
    expect(textOf(tree, "offline-title-song:t3")).toBe(en.offlineContent.unknown);
    const arts = renderArtwork.mock.calls.map(([row, size]) => `${row.key}@${size}`);
    console.info(`[${SUITE}] parrot artwork`, arts);
    expect(new Set(arts)).toEqual(new Set(["artist:ar1@44", "album:al1@36"]));
    // The frame behind an artist's round picture is round too; an album's keeps its small square corners.
    const frameRadius = (key: string) => Object.assign({}, ...[byTestId(tree, `art-${key}`)[0]!.parent!.props.style].flat(Infinity).filter(Boolean)).borderRadius;
    console.info(`[${SUITE}] parrot art frames`, frameRadius("artist:ar1"), frameRadius("album:al1"));
    expect(frameRadius("artist:ar1")).toBe(22);
    expect(frameRadius("album:al1")).toBe(6);
    for (const key of ["artist:ar1", "album:al1", "song:t1", "song:t2", "song:t3"]) expect(byTestId(tree, `offline-remove-${key}`)).toHaveLength(1);
    await press(tree, "offline-remove-song:t2");
    expect(onRemove.mock.calls[0]![0]).toMatchObject({ key: "song:t2", kind: "song", id: "t2", fileId: "s2" });

    const summary = byTestId(tree, "offline-content-total")[0]!;
    const summaryLine = [summary.parent!.props.children].flat().map((child) => (typeof child === "string" ? child : "<total>")).join("");
    console.info(`[${SUITE}] parrot summary`, textOf(tree, "offline-content-total"), summaryLine);
    expect(textOf(tree, "offline-content-total")).toBe("15 MB");
    expect(summaryLine).toBe(`<total> ${en.offlineContent.totalSuffix}`);
    await press(tree, "offline-content-remove-all");
    expect(h.alert.mock.calls[0]![0]).toBe(en.offlineContent.parrot.confirmTitle);
    expect(h.alert.mock.calls[0]![1]).toBe(en.offlineContent.parrot.confirmBody);

    const empty = await render({ app: "parrot", list: { rows: [], totalBytes: 0 } });
    console.info(`[${SUITE}] parrot empty`, textOf(empty.tree, "offline-content-empty"));
    expect(textOf(empty.tree, "offline-content-empty")).toBe(en.offlineContent.parrot.empty);
    expect(byTestId(empty.tree, "offline-content-remove-all")).toHaveLength(0);
  });

  it("Badger empty state points to Download; a loading list shows a spinner, not a total", async () => {
    const { tree } = await render({ list: { rows: [], totalBytes: 0 } });
    expect(textOf(tree, "offline-content-empty")).toBe(en.offlineContent.badger.empty);
    expect(textOf(tree, "offline-content-total")).toMatch(/^0 MB$/);
    const loading = await render({ list: null });
    console.info(`[${SUITE}] loading`, byTestId(loading.tree, "offline-content-loading").length);
    expect(byTestId(loading.tree, "offline-content-loading")).toHaveLength(1);
    expect(byTestId(loading.tree, "offline-content-total")).toHaveLength(0);
    expect(byTestId(loading.tree, "offline-content-empty")).toHaveLength(0);
  });
});
