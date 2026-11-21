import React, { memo, useCallback, useMemo, useState } from "react";
import { StyleSheet, TVFocusGuideView, View } from "react-native";
import { ArrowDownUp, ChevronDown, Film, Tv } from "lucide-react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { MobileLibraryLoading, SkyCover } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { EMPTY_LIBRARY_FILTERS, LIBRARY_SORT_KEYS, type LibrarySortBy, type LibraryTab } from "@space/shared/libraryView";
import { libraryContent } from "@space/shared/libraryContent";
import { useAppSettings } from "../../lib/appSettings";
import { selectLibraryItems } from "../../lib/libraryScreenState";
import type { RootStackParamList } from "../../navigation/AppNavigator";
import { useLibraryData, useLibraryStatus } from "../../store/library";
import { TvEmptyLibrary } from "../components/TvEmptyLibrary";
import { TvPosterGrid } from "../components/TvPosterGrid";
import { TV_SCREEN_X } from "@space/mobile-shell/tv/layout";
import { useTvScale, useTvStyles } from "@space/mobile-shell/tv/tvScale";
import { TvChip, TvSegmented } from "@space/mobile-shell/tv/TvChip";
import { TvBody } from "@space/mobile-shell/tv/TvText";

const MASCOT = require("../../assets/mascot.webp");

type Nav = NativeStackNavigationProp<RootStackParamList>;

const NO_CAST = new Map<string, Set<string>>();
const NO_DOWNLOADS: ReadonlySet<string> = new Set();

/** The sort chip's next order: name A to Z, newest added first, newest release first, and round again. */
export const nextLibrarySort = (sortBy: LibrarySortBy): { sortBy: LibrarySortBy; sortDirection: "asc" | "desc" } => {
  const next = LIBRARY_SORT_KEYS[(LIBRARY_SORT_KEYS.indexOf(sortBy) + 1) % LIBRARY_SORT_KEYS.length];
  return { sortBy: next, sortDirection: next === "name" ? "asc" : "desc" };
};

/**
 * TV Library (UX-TV-09, mockup `tv-library`): the Movies / TV shows switch at the left and the sort chip at the right of
 * one line, then eight captioned posters across on the sky. No title, no count and no focused-title line. Playlists are
 * their own top-bar section (UX-TV-37). An empty library shows the freestanding Badger and "Check again" (UX-TV-18),
 * only once it is known to be empty; until then the app's opening screen says "Loading library" (UX-WAIT-04).
 */
export const TvLibraryScreen = memo(() => {
  const { t } = useTranslation();
  const { media } = useLibraryData();
  const { settled, reload } = useLibraryStatus();
  const navigation = useNavigation<Nav>();
  const [settings, updateSettings] = useAppSettings();
  const [tab, setTab] = useState<LibraryTab>("movie");
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  const prefs = settings.libraryView[tab];

  const openMedia = useCallback((mediaId: string) => navigation.navigate("MediaDetails", { mediaId }), [navigation]);

  const scopes = useMemo(
    () =>
      [
        { value: "movie", label: t("library.scopes.movies"), icon: Film },
        { value: "tv", label: t("library.scopes.tv"), icon: Tv },
      ] as const,
    [t],
  );

  const items = useMemo(
    () =>
      selectLibraryItems({
        media,
        tab,
        filters: EMPTY_LIBRARY_FILTERS,
        prefs,
        castLookup: NO_CAST,
        downloadedMediaIds: NO_DOWNLOADS,
      }),
    [media, tab, prefs],
  );

  const selectTab = useCallback(
    (next: LibraryTab) => {
      console.info("tv.library.scope", JSON.stringify({ from: tab, to: next }));
      setTab(next);
    },
    [tab],
  );

  const cycleSort = useCallback(() => {
    const next = nextLibrarySort(prefs.sortBy);
    console.info("tv.library.sort", JSON.stringify({ tab, from: prefs.sortBy, to: next.sortBy }));
    updateSettings({ libraryView: { ...settings.libraryView, [tab]: { ...prefs, ...next } } });
  }, [tab, prefs, settings.libraryView, updateSettings]);

  const content = libraryContent({ itemCount: media.length, settled });
  if (content === "loading") return <MobileLibraryLoading app="badger" source={MASCOT} label={t("nav.loadingLibrary")} size={180} />;
  if (content === "empty") {
    return (
      <View style={styles.empty}>
        <TvEmptyLibrary onCheckAgain={reload} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {/* One full-width guide: UP from any poster finds the bar, and a move into the bar lands on the last choice used. */}
      <TVFocusGuideView autoFocus style={styles.bar}>
        <SkyCover>
          <TvSegmented options={scopes} value={tab} onChange={selectTab} testID="tv-library-scope" />
        </SkyCover>
        <SkyCover>
          <TvChip
            icon={ArrowDownUp}
            iconEnd={ChevronDown}
            label={t(`library.sort.${prefs.sortBy}`)}
            onPress={cycleSort}
            accessibilityLabel={`${t("library.sheet.sortBy")}: ${t(`library.sort.${prefs.sortBy}`)}`}
            testID="tv-library-sort"
          />
        </SkyCover>
      </TVFocusGuideView>
      <View style={styles.panel} testID="tv-library-panel">
        {items.length === 0 ? (
          <TvBody muted style={styles.tabEmpty} testID="tv-library-tab-empty">
            {tab === "movie" ? t("library.empty.noMovies") : t("library.empty.noShows")}
          </TvBody>
        ) : (
          // The tab and the sort change the grid's content: a new list starts at its top.
          <TvPosterGrid key={`${tab}:${prefs.sortBy}:${scale}`} items={items} onOpenMedia={openMedia} />
        )}
      </View>
    </View>
  );
});
TvLibraryScreen.displayName = "TvLibraryScreen";

/** Sizes in design dp (mockup `.bar0` px halved, scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  screen: { flex: 1 },
  empty: { flex: 1, justifyContent: "center" },
  bar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingTop: 18, paddingHorizontal: TV_SCREEN_X },
  panel: { flex: 1 },
  tabEmpty: { paddingHorizontal: TV_SCREEN_X, paddingTop: 6 },
});
