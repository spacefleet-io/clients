// Parrot TV's main shell (PAR-TV-01, PAR-TV-03, PAR-TV-10, PAR-TV-12, PAR-TV-13): the family's TV top bar (Badger TV's, UX-TV-09)
// with Parrot's mark and music-list Playlists icon over the night sky, the open section under it, and the pages opened
// over it (`tvPages`): the album, playlist and artist pages keep the bar, Now playing, the lyrics, Up next and the
// profiles fill the screen. Back closes the topmost page, then returns a section other than Home to Home; on Home it
// leaves the app as usual. The remote's play and pause, next and previous keys work from every screen. The TV stays
// awake only while Now playing or the lyrics are on top.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, StyleSheet, View } from "react-native";
import { ListMusic } from "lucide-react-native";
import { scopeLogger } from "@space/mobile-shell/logger";
import { MobileRenderBoundary } from "@space/mobile-shell/render-boundary";
import { TvProfilesView } from "@space/mobile-shell/tv/TvProfiles";
import { TvTopBar } from "@space/mobile-shell/tv/TvTopBar";
import { setCurrentTvSection, subscribeTvSectionRequest, type TvSectionId } from "@space/mobile-shell/tv/tvSection";
import { useTvMenuKeyHold } from "@space/mobile-shell/tv/useTvMenuKey";
import { TvFocusGuide } from "@space/mobile-shell/tv/TvFocusGuide";
import { useTvScale } from "@space/mobile-shell/tv/tvScale";
import { UnpaidAccessSign } from "@space/mobile-shell/unpaid-access-sign";
import type { TvViewInstance } from "@space/mobile-shell/tv/tvViewInstance";
import type { NoticeHistory } from "@space/notify-core/history";
import type { ParrotAlbumSort } from "@space/parrot-core";
import { PARROT_TV_ICON } from "../brand";
import { NO_LIBRARY_MOVES } from "@space/shared/profileStore";
import { profileStore } from "../lib/profiles";
import { useSession } from "../state/session";
import { useParrotNoticeHistory } from "../state/notices";
import { TvAlbumPage } from "./TvAlbumPage";
import { TvArtistPage } from "./TvArtistPage";
import { TvHomeSection } from "./TvHomeSection";
import { TvLibrarySection } from "./TvLibrarySection";
import { TvLyricsPage } from "./TvLyricsPage";
import { TvNowPlayingPage } from "./TvNowPlayingPage";
import { TvPlaylistsSection } from "./TvPlaylistsSection";
import { TvPlayerSky } from "./TvPlayerSky";
import { TvQueuePage } from "./TvQueuePage";
import { TvSearchSection } from "./TvSearchSection";
import { TvSettingsSection } from "./TvSettingsSection";
import { pushTvPage, tvPageHasTopBar, tvPageKeepsAwake, tvPageKey, type TvPage } from "./tvModel";
import { TvPagesContext, type TvPages } from "./tvPages";
import { useTvKeepAwake } from "./useTvKeepAwake";
import { useTvRemoteKeys } from "./useTvRemoteKeys";

const log = scopeLogger("parrot.tv.shell");

const profilesLog = (event: string, data: Record<string, unknown>) => console.info(`parrot.tv.profiles.${event}`, JSON.stringify(data));

type SectionProps = {
  id: TvSectionId;
  onSeeAll: (albumSort?: ParrotAlbumSort) => void;
  librarySort: ParrotAlbumSort | null;
  history: NoticeHistory | null;
};

const Section = ({ id, onSeeAll, librarySort, history }: SectionProps) => {
  switch (id) {
    case "home":
      return <TvHomeSection onSeeAll={onSeeAll} />;
    case "library":
      return <TvLibrarySection albumSort={librarySort} />;
    case "playlists":
      return <TvPlaylistsSection />;
    case "search":
      return <TvSearchSection />;
    case "settings":
      return <TvSettingsSection history={history} />;
    default:
      return null;
  }
};

const Page = ({ page, pop, shown }: { page: TvPage; pop: () => void; shown: boolean }) => {
  switch (page.kind) {
    case "album":
      return <TvAlbumPage source={{ kind: "album", albumId: page.albumId }} />;
    case "playlist":
      return <TvAlbumPage source={{ kind: "playlist", playlistId: page.playlistId, name: page.name }} />;
    case "artist":
      return <TvArtistPage artistId={page.artistId} name={page.name} />;
    case "nowPlaying":
      return <TvNowPlayingPage shown={shown} />;
    case "lyrics":
      return <TvLyricsPage />;
    case "queue":
      return <TvQueuePage />;
    case "profiles":
      return <TvProfilesView store={profileStore} moves={NO_LIBRARY_MOVES} startMode={page.mode} inApp audience="listening" onPicked={pop} onClose={pop} log={profilesLog} />;
  }
};

export const TvMainShell = () => {
  const { access } = useSession();
  // UX-NOTICE-04 / UX-NOTICE-05: the TV's notice history, read by Settings ▸ Account; kept here so the account's news
  // keeps arriving while another section shows.
  const history = useParrotNoticeHistory();
  const scale = useTvScale();
  const [active, setActive] = useState<TvSectionId>("home");
  // The album order Home's "See all" asked the Library for ("Recently added": newest first, PAR-HOME-01); null when the
  // Library tab is picked on the bar, which lists the albums by artist.
  const [librarySort, setLibrarySort] = useState<ParrotAlbumSort | null>(null);
  const [stack, setStack] = useState<TvPage[]>([]);
  const guides = useRef<Record<string, TvViewInstance | null>>({});
  const refocus = useRef<"push" | "pop" | null>(null);
  useTvRemoteKeys();

  // A page opened from here names this section on its Back button (UX-TV-06), and a tab picked there opens it here.
  useEffect(() => {
    setCurrentTvSection(active);
    log.info("section", { section: active });
  }, [active]);

  // A tab picked on the bar (or asked for from elsewhere) opens that section and closes the pages over the one before.
  const select = useCallback((section: TvSectionId) => {
    setStack([]);
    setLibrarySort(null);
    setActive(section);
  }, []);
  useEffect(() => subscribeTvSectionRequest(select), [select]);

  // A row's "See all" on Home opens the Library, in the row's own order when it has one.
  const seeAll = useCallback(
    (albumSort?: ParrotAlbumSort) => {
      log.info("see_all", { albumSort: albumSort ?? null });
      select("library");
      setLibrarySort(albumSort ?? null);
    },
    [select],
  );

  const pages = useMemo<TvPages>(
    () => ({
      push: (page) => {
        refocus.current = "push";
        setStack((open) => {
          const next = pushTvPage(open, page);
          log.info("page_push", { page: tvPageKey(page), depth: next.length });
          return next;
        });
      },
      pop: () => {
        refocus.current = "pop";
        setStack((open) => {
          log.info("page_pop", { page: open.length > 0 ? tvPageKey(open[open.length - 1]!) : null, depth: Math.max(0, open.length - 1) });
          return open.slice(0, -1);
        });
      },
    }),
    []
  );

  // PAR-TV-10: Back closes the topmost page, then returns a section other than Home to Home; on Home with no page open
  // the system has it (the app leaves). Registered once, reading the current state, so a page's own Back handler (the
  // profiles' sub-steps), registered after it, keeps going first.
  const backState = useRef({ active, depth: stack.length });
  backState.current = { active, depth: stack.length };
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      const { active: section, depth } = backState.current;
      if (depth > 0) {
        pages.pop();
        return true;
      }
      if (section === "home") return false;
      log.info("back_to_home", { from: section });
      setActive("home");
      return true;
    });
    return () => subscription.remove();
  }, [pages]);
  // Apple TV delivers Menu to the handler above only while the key is held; on Home the system keeps it (-> Apple TV home).
  useTvMenuKeyHold("tv-tab", stack.length > 0 || active !== "home");

  const top = stack.length > 0 ? stack[stack.length - 1]! : null;
  const fullScreen = top !== null && !tvPageHasTopBar(top);
  useTvKeepAwake(tvPageKeepsAwake(top));
  // Under the bar: the section, then every page in the stack that keeps the bar; the topmost of them shows.
  const layers: Array<{ key: string; page: TvPage | null }> = [
    { key: `section:${active}`, page: null },
    ...stack.filter(tvPageHasTopBar).map((page) => ({ key: `page:${tvPageKey(page)}`, page })),
  ];
  const shown = layers[layers.length - 1]!;

  // Full-screen pages stay mounted (hidden) under the one opened over them, so Back from the lyrics or Up next finds Now
  // playing as it was; Now playing itself hands the focus back to the button that opened them.
  const screens = stack.filter((page) => !tvPageHasTopBar(page));

  // The layer under the bar that shows after a push or a pop gets the focus from its guide. Back lands on the card or
  // button that opened the page: the layer kept its views (hidden) and its guide remembers the last one focused. A page
  // just opened keeps its own first focus (`hasTVPreferredFocus`), which Android hands to the top bar when the layer it
  // was opened from hides in the same frame; its guide gives it back (or its first control, before it focused one).
  const visibleLayer = fullScreen ? null : shown.key;
  useEffect(() => {
    const why = refocus.current;
    if (why === null) return undefined;
    refocus.current = null;
    if (visibleLayer === null) return undefined;
    const guide = guides.current[visibleLayer] ?? null;
    log.info("focus_layer", { why, layer: visibleLayer, guide: guide !== null });
    const frame = requestAnimationFrame(() => guide?.requestTVFocus());
    return () => cancelAnimationFrame(frame);
  }, [stack, visibleLayer]);

  return (
    <TvPagesContext.Provider value={pages}>
      <TvPlayerSky>
        {/* Under a full-screen page the bar and its layers stay mounted but hidden (out of the remote's reach), so Back
            returns to the same card and scroll position. */}
        <View style={[styles.shell, fullScreen && styles.hidden]} testID="parrot-tv-shell">
          <TvTopBar brandIcon={PARROT_TV_ICON} playlistsIcon={ListMusic} active={active} onSelect={select} />
          <View style={styles.content}>
            {layers.map((layer) => (
              <TvFocusGuide
                key={layer.key}
                autoFocus
                enabled={layer === shown}
                style={styles.content}
                ref={(view: TvViewInstance | null) => {
                  guides.current[layer.key] = view;
                }}
                testID={layer.page ? `parrot-tv-page-${layer.page.kind}` : `parrot-tv-section-${active}`}
              >
                <MobileRenderBoundary name={layer.page ? `tv-page:${tvPageKey(layer.page)}` : `tv-section:${active}`} resetKey={layer.key}>
                  {layer.page ? (
                    <Page page={layer.page} pop={pages.pop} shown={layer === shown} />
                  ) : (
                    <Section id={active} onSeeAll={seeAll} librarySort={librarySort} history={history} />
                  )}
                </MobileRenderBoundary>
              </TvFocusGuide>
            ))}
          </View>
          {/* ACCT-UNPAID-05, UX-NOTICE-08: while the account is unpaid, every section and every page opened under the
              bar (an album, an artist, a playlist) shows the small unpaid sign under the bar. It floats over the page,
              only informs and is not focusable: nothing on the TV links to paying (ACCT-PAY-02). */}
          <UnpaidAccessSign access={access} tv scale={scale} />
        </View>
        {screens.map((page) => (
          <View key={tvPageKey(page)} style={[StyleSheet.absoluteFill, page !== top && styles.hidden]} testID={`parrot-tv-page-${page.kind}`}>
            <View style={styles.content}>
              <MobileRenderBoundary name={`tv-page:${tvPageKey(page)}`} resetKey={tvPageKey(page)}>
                <Page page={page} pop={pages.pop} shown={page === top} />
              </MobileRenderBoundary>
            </View>
            {/* ACCT-UNPAID-05: Who's listening? fills the screen, so it carries the sign itself; Now playing, its
                lyrics and Up next are the player, which stays clear of it. */}
            {page.kind === "profiles" ? <UnpaidAccessSign access={access} tv underBar={false} scale={scale} /> : null}
          </View>
        ))}
      </TvPlayerSky>
    </TvPagesContext.Provider>
  );
};

const styles = StyleSheet.create({
  shell: { flex: 1 },
  hidden: { display: "none" },
  content: { flex: 1 },
});
