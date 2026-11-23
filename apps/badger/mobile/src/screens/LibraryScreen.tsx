import React, { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { ArrowDownWideNarrow, Film, Tv } from "lucide-react-native";
import {
  EMPTY_LIBRARY_FILTERS,
  countActiveLibraryFilters,
  hasActiveLibraryFilters,
} from "@space/shared/libraryView";
import { MobileEmptyState, SkyCover } from "@space/mobile-shell/components";
import { useTranslation } from "@space/mobile-shell/i18n";
import { useLibraryActions, useLibraryData, useLibraryStatus } from "../store/library";
import { RootStackParamList } from "../navigation/AppNavigator";
import { PosterGrid } from "../components/PosterGrid";
import { IconButton } from "../components/IconButton";
import { LibraryFilterSheet } from "../components/LibraryFilterSheet";
import { usePickerSheet } from "../components/usePickerSheet";
import { RIPPLE } from "../components/PosterCard";
import { usePullToRefresh } from "../lib/usePullToRefresh";
import { useDownloadedMediaIds } from "../lib/downloads/downloadsStore";
import { useAppSettings } from "../lib/appSettings";
import { genreLabelKey } from "../lib/genreLabels";
import { EMPTY_LIBRARY_EXTRAS, fetchLibraryExtras, type LibraryExtras } from "../lib/libraryExtras";
import { scopeLogger } from "@space/mobile-shell/logger";
import {
  availableGenreIds,
  libraryFiltersReducer,
  selectLibraryItems,
  type LibraryScope,
  updateLibraryTabPrefs,
} from "../lib/libraryScreenState";
import { theme } from "../theme/theme";

type Nav = NativeStackNavigationProp<RootStackParamList>;

const log = scopeLogger("library");

const EMPTY_STATE_IMAGE = require("../assets/empty-state.webp");
const SCOPES: readonly { id: LibraryScope; labelKey: string; icon: typeof Film }[] = [
  { id: "movies", labelKey: "library.scopes.movies", icon: Film },
  { id: "tv", labelKey: "library.scopes.tv", icon: Tv },
];

type LibraryScreenProps = {
  /** False while another tab is showing: filters reset then (the pager keeps this screen mounted). */
  active: boolean;
  /** Home's "See all" on the Movies or TV shows row asks for that scope; a new object each time, so a repeat works. */
  scopeRequest?: { scope: LibraryScope } | null;
};

/**
 * Library tab, drawn as the validated mockup (UX-PHONE-06): no page title; the Movies / TV shows switch with a solid
 * yellow selected tab and, beside it, one sort button (which opens the sort and filter sheet); movies / TV shows as a
 * poster grid with watch progress. No search field: the bar's centre Search button searches the whole library
 * (UX-PHONE-12). Playlists are their own tab (UX-PHONE-07). Sort is remembered per tab on this device; filters are not.
 */
export const LibraryScreen = memo(({ active, scopeRequest }: LibraryScreenProps) => {
  const { t } = useTranslation();
  const { media } = useLibraryData();
  const { loading, error, refresh } = useLibraryStatus();
  const { getLibraryExtras } = useLibraryActions();
  const navigation = useNavigation<Nav>();
  const [scope, setScope] = useState<LibraryScope>("movies");
  const [filters, dispatch] = useReducer(libraryFiltersReducer, EMPTY_LIBRARY_FILTERS);
  const [settings] = useAppSettings();
  const [extras, setExtras] = useState<LibraryExtras | null>(null);
  const downloadedMediaIds = useDownloadedMediaIds();
  const pull = usePullToRefresh(refresh);
  const sheet = usePickerSheet();

  const tab = scope === "tv" ? "tv" : "movie";
  const prefs = settings.libraryView[tab];
  const activeFilterCount = countActiveLibraryFilters(filters);

  useEffect(() => {
    if (!active) dispatch({ type: "reset" });
  }, [active]);

  // Cast, seasons and runtimes sit in the metadata / playback databases: only read them once something needs them.
  const needsExtras = sheet.visible || filters.actors.length > 0;
  // `media` changes identity whenever the library data is refreshed (sync, metadata edit, progress), which is also when
  // cast / seasons / runtimes can change, so the read repeats then.
  useEffect(() => {
    if (!needsExtras) return undefined;
    return fetchLibraryExtras(getLibraryExtras, setExtras, (error) =>
      log.error("extras.failed", { error: error instanceof Error ? error.message : String(error) }),
    );
  }, [needsExtras, getLibraryExtras, media]);

  const openMedia = useCallback(
    (mediaId: string) => navigation.navigate("MediaDetails", { mediaId }),
    [navigation],
  );

  const castLookup = (extras ?? EMPTY_LIBRARY_EXTRAS).castByMediaId;
  const items = useMemo(
    () =>
      selectLibraryItems({
        media,
        tab,
        filters,
        prefs,
        castLookup,
        downloadedMediaIds,
      }),
    [media, tab, filters, prefs, castLookup, downloadedMediaIds],
  );

  const genreOptions = useMemo(
    () =>
      availableGenreIds(media, tab).flatMap((id) => {
        const key = genreLabelKey(tab, id);
        return key ? [{ value: `${tab}:${id}`, label: t(key) }] : [];
      }),
    [media, tab, t],
  );

  const changeScope = useCallback(
    (next: LibraryScope) => {
      setScope(next);
      dispatch({ type: "switchTab", from: scope, to: next });
    },
    [scope],
  );
  const handledScopeRequest = useRef<LibraryScreenProps["scopeRequest"]>(null);
  useEffect(() => {
    if (!scopeRequest || handledScopeRequest.current === scopeRequest) return;
    handledScopeRequest.current = scopeRequest;
    if (scopeRequest.scope !== scope) changeScope(scopeRequest.scope);
  }, [changeScope, scope, scopeRequest]);
  const changePrefs = useCallback(
    (patch: Parameters<typeof updateLibraryTabPrefs>[1]) => updateLibraryTabPrefs(tab, patch),
    [tab],
  );

  const filtered = hasActiveLibraryFilters(filters);
  const empty = (
    <MobileEmptyState
      title={filtered ? t("library.empty.noMatches") : scope === "movies" ? t("library.empty.noMovies") : t("library.empty.noShows")}
      subtitle={filtered ? t("library.empty.noMatchesHint") : t("library.empty.addHint")}
      imageSource={EMPTY_STATE_IMAGE}
    />
  );

  const sheetLabel =
    activeFilterCount > 0 ? t("library.sheet.openActive", { count: activeFilterCount }) : t("library.sheet.open");

  return (
    <View style={styles.page}>
      <View style={styles.body}>
        <View style={styles.toolbar}>
        <SkyCover style={styles.scopes} accessibilityRole="tablist">
          {SCOPES.map(({ id, labelKey, icon: Icon }) => {
            const selected = scope === id;
            const label = t(labelKey);
            return (
              <Pressable
                key={id}
                style={[styles.scope, selected && styles.scopeActive]}
                hitSlop={SCOPE_HIT_SLOP}
                onPress={() => changeScope(id)}
                android_ripple={RIPPLE}
                accessibilityRole="tab"
                testID={`library-scope-${id}`}
                accessibilityLabel={label}
                accessibilityState={{ selected }}
              >
                <Icon size={15} color={selected ? theme.accentTextHex : theme.colors.textMuted} />
                <Text style={[styles.scopeLabel, selected && styles.scopeLabelActive]}>{label}</Text>
              </Pressable>
            );
          })}
        </SkyCover>
          {/* The box sits on the wrapper: on Android a Pressable's ripple replaces its own background and border. */}
          <SkyCover style={[styles.sortButton, activeFilterCount > 0 && styles.sortButtonActive]}>
            <IconButton label={sheetLabel} onPress={sheet.open} style={styles.sortPress}>
              <ArrowDownWideNarrow size={16} color={activeFilterCount > 0 ? theme.colors.accent : theme.colors.text} />
              {activeFilterCount > 0 ? (
                <View style={styles.countBadge} accessible={false}>
                  <Text style={styles.countBadgeLabel}>{activeFilterCount}</Text>
                </View>
              ) : null}
            </IconButton>
          </SkyCover>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.grid}>
          <PosterGrid
            items={items}
            onOpenMedia={openMedia}
            pull={pull}
            loading={loading}
            empty={empty}
            bottomInset={0}
            showProgress
          />
        </View>

        <LibraryFilterSheet
          sheet={sheet}
          prefs={prefs}
          onChangePrefs={changePrefs}
          filters={filters}
          dispatch={dispatch}
          genreOptions={genreOptions}
          actorNames={extras ? extras.actorNames : null}
        />
      </View>
    </View>
  );
});
LibraryScreen.displayName = "LibraryScreen";

/** The switch's tabs are 34 dp tall as in the mockup; the slop keeps the touch target at 42 dp. */
const SCOPE_HIT_SLOP = { top: 4, bottom: 4, left: 2, right: 2 };

const styles = StyleSheet.create({
  page: { flex: 1, paddingTop: 8, gap: 12 },
  body: { flex: 1, gap: 12, marginBottom: 8 },
  scopes: {
    flex: 1,
    flexDirection: "row",
    padding: 4,
    gap: 4,
    borderRadius: 12,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  scope: {
    flex: 1,
    height: 34,
    borderRadius: 9,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    overflow: "hidden",
  },
  scopeActive: { backgroundColor: theme.colors.accent },
  scopeLabel: { fontSize: 13, fontWeight: "700", color: theme.colors.textMuted },
  scopeLabelActive: { color: theme.accentTextHex },
  toolbar: { flexDirection: "row", gap: 8, alignItems: "center" },
  sortButton: {
    width: 42,
    height: 42,
    borderRadius: 10,
    backgroundColor: theme.colors.surface,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  sortPress: { width: 40, height: 40, borderRadius: 10 },
  sortButtonActive: { borderColor: theme.colors.accent },
  countBadge: {
    position: "absolute",
    top: -6,
    right: -6,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.accent,
  },
  countBadgeLabel: { fontSize: 11, fontWeight: "800", color: theme.accentTextHex },
  error: { fontSize: 12, color: theme.colors.danger },
  grid: { flex: 1 },
});
