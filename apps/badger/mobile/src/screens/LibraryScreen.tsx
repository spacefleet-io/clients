import React, { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { Film, Tv } from "lucide-react-native";
import {
  EMPTY_LIBRARY_FILTERS,
  countActiveLibraryFilters,
  hasActiveLibraryFilters,
  type LibraryFilters,
  type LibrarySortBy,
  type LibrarySortDirection,
} from "@space/shared/libraryView";
import {
  LIBRARY_FACETS,
  LIBRARY_WATCH_STATES,
  countLibraryFacetSelection,
  libraryFacetOptions,
  libraryFacetValues,
  libraryFacetsMatch,
  type LibraryFacet,
  type LibraryFacetSelection,
  type LibraryFacetValues,
} from "@space/shared/libraryFacets";
import { formatMediaLanguageLabelForUi } from "@space/shared/mediaLanguageDisplay";
import { MobileEmptyState } from "@space/mobile-shell/components";
import {
  MobileLibraryFilterPicker,
  MobileLibraryHeader,
  MobileLibraryPills,
  MobileLibrarySegmented,
  MobileLibrarySheet,
  MobileLibrarySheetButtons,
  MobileLibrarySheetSection,
  type MobileLibraryCount,
} from "@space/mobile-shell/library-row";
import { useTranslation } from "@space/mobile-shell/i18n";
import { useLibraryActions, useLibraryData, useLibraryStatus } from "../store/library";
import { RootStackParamList } from "../navigation/AppNavigator";
import { PosterGrid } from "../components/PosterGrid";
import { usePullToRefresh } from "../lib/usePullToRefresh";
import { useDownloadedMediaIds } from "../lib/downloads/downloadsStore";
import { useAppSettings } from "../lib/appSettings";
import { genreLabelKey } from "../lib/genreLabels";
import { fetchLibraryExtras, type LibraryExtras } from "../lib/libraryExtras";
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
const EMPTY_CAST: Map<string, Set<string>> = new Map();
/** A list drawn from the library shows only with two choices or more (UX-LIB-01); Watch state always shows. */
const MIN_CHOICES = 2;
const SORTS: readonly LibrarySortBy[] = ["name", "added", "release"];
const DIRECTIONS: readonly LibrarySortDirection[] = ["asc", "desc"];

type LibraryScreenProps = {
  /** False while another tab is showing: filters reset then (the pager keeps this screen mounted). */
  active: boolean;
  /** Home's "See all" on the Movies or TV shows row asks for that scope; a new object each time, so a repeat works. */
  scopeRequest?: { scope: LibraryScope } | null;
};

/** What the Filter sheet edits before Apply: the list filters and the UX-LIB-03 facets. */
type Draft = { filters: LibraryFilters; facets: LibraryFacetSelection };
type Sheet = "filter" | "sort" | null;

/**
 * Library tab (UX-PHONE-06, UX-LIB-01, UX-LIB-03): no page title; the desktop's library row brought to the phone: the
 * Movies / TV shows switch, the quiet counts and the Filter and Sort buttons (DRAFT layouts A / B / C, see
 * @space/mobile-shell/library-row), then movies / TV shows as a poster grid with watch progress. Filter opens chip
 * lists (genres, actors, quality, director, languages, watch state, downloaded only) applied on Apply; Sort the order.
 * No search field: the bar's centre Search button searches the whole library (UX-PHONE-12). Playlists are their own
 * tab (UX-PHONE-07). Sort is remembered per tab on this device; filters are not.
 */
export const LibraryScreen = memo(({ active, scopeRequest }: LibraryScreenProps) => {
  const { t, i18n } = useTranslation();
  const { media } = useLibraryData();
  const { loading, error, refresh } = useLibraryStatus();
  const { getLibraryExtras } = useLibraryActions();
  const navigation = useNavigation<Nav>();
  const [scope, setScope] = useState<LibraryScope>("movies");
  const [filters, dispatch] = useReducer(libraryFiltersReducer, EMPTY_LIBRARY_FILTERS);
  const [facets, setFacets] = useState<LibraryFacetSelection>({});
  const [settings] = useAppSettings();
  const [extras, setExtras] = useState<LibraryExtras | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [draft, setDraft] = useState<Draft>({ filters: EMPTY_LIBRARY_FILTERS, facets: {} });
  const downloadedMediaIds = useDownloadedMediaIds();
  const pull = usePullToRefresh(refresh);

  const tab = scope === "tv" ? "tv" : "movie";
  const prefs = settings.libraryView[tab];
  const facetCount = countLibraryFacetSelection(facets);
  const activeFilterCount = countActiveLibraryFilters(filters) + facetCount;

  useEffect(() => {
    if (active) return;
    dispatch({ type: "reset" });
    setFacets({});
    setSheet(null);
  }, [active]);

  // Cast, facets, seasons and runtimes sit in the metadata / playback databases: only read them once something needs them.
  const needsExtras = sheet !== null || filters.actors.length > 0 || facetCount > 0;
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

  // Each title's facet keys: its formats, directors and languages from the extras, its watch state from its progress.
  const facetValues = useMemo(() => {
    const values = new Map<string, LibraryFacetValues>();
    for (const item of media) {
      if (item.type !== tab) continue;
      values.set(item.id, libraryFacetValues({ ...extras?.facetsByMediaId.get(item.id), progressPct: item.progressPct }));
    }
    return values;
  }, [media, tab, extras]);
  const castLookup = extras?.castByMediaId ?? EMPTY_CAST;
  const inTabCount = useMemo(() => media.filter((item) => item.type === tab).length, [media, tab]);
  const items = useMemo(
    () =>
      selectLibraryItems({ media, tab, filters, prefs, castLookup, downloadedMediaIds }).filter((item) =>
        libraryFacetsMatch(facetValues.get(item.id), facets),
      ),
    [media, tab, filters, prefs, castLookup, downloadedMediaIds, facetValues, facets],
  );

  const genreOptions = useMemo(
    () =>
      availableGenreIds(media, tab).flatMap((id) => {
        const key = genreLabelKey(tab, id);
        return key ? [{ value: `${tab}:${id}`, label: t(key) }] : [];
      }),
    [media, tab, t],
  );
  const actorOptions = useMemo(() => {
    if (!extras) return [];
    const inTab = new Set<string>();
    for (const item of media) if (item.type === tab) extras.castByMediaId.get(item.id)?.forEach((name) => inTab.add(name));
    return extras.actorNames.filter((name) => inTab.has(name.toLowerCase())).map((name) => ({ value: name.toLowerCase(), label: name }));
  }, [extras, media, tab]);
  const facetSections = useMemo(() => {
    const options = libraryFacetOptions(facetValues.values());
    const undefinedLanguage = t("library.filters.undefinedLanguage");
    const label = (facet: LibraryFacet, key: string): string => {
      switch (facet) {
        case "qualities":
          return key === "sd" ? t("library.filters.quality.sd") : key === "4k" || key === "2k" ? key.toUpperCase() : key;
        case "watchStates":
          return t(`library.filters.watchState.${key}`);
        case "directors":
          return key.replace(/\b\w/g, (letter) => letter.toUpperCase());
        default:
          return formatMediaLanguageLabelForUi(key, i18n.language, undefinedLanguage);
      }
    };
    // Watch state is a fixed set, offered whole; the other kinds come from the library and need two choices to filter.
    return LIBRARY_FACETS.filter((facet) => facet === "watchStates" || options[facet].length >= MIN_CHOICES).map((facet) => ({
      facet,
      options: (facet === "watchStates" ? LIBRARY_WATCH_STATES : options[facet]).map((key) => ({ value: key, label: label(facet, key) })),
    }));
  }, [facetValues, t, i18n.language]);

  const changeScope = useCallback(
    (next: LibraryScope) => {
      setScope(next);
      dispatch({ type: "switchTab", from: scope, to: next });
      if (next !== scope) setFacets({});
    },
    [scope],
  );
  const handledScopeRequest = useRef<LibraryScreenProps["scopeRequest"]>(null);
  useEffect(() => {
    if (!scopeRequest || handledScopeRequest.current === scopeRequest) return;
    handledScopeRequest.current = scopeRequest;
    if (scopeRequest.scope !== scope) changeScope(scopeRequest.scope);
  }, [changeScope, scope, scopeRequest]);

  const filtered = hasActiveLibraryFilters(filters) || facetCount > 0;
  const empty = (
    <MobileEmptyState
      title={filtered ? t("library.empty.noMatches") : scope === "movies" ? t("library.empty.noMovies") : t("library.empty.noShows")}
      subtitle={filtered ? t("library.empty.noMatchesHint") : t("library.empty.addHint")}
      imageSource={EMPTY_STATE_IMAGE}
    />
  );

  // UX-LIB-01: the quiet counts, "21 movies · 8 shows"; with a filter on, "12 of 21 movies" for the open tab.
  const statKey = tab === "movie" ? "library.stats.movie" : "library.stats.series";
  const totals = { movie: media.filter((item) => item.type === "movie").length, tv: media.filter((item) => item.type === "tv").length };
  const counts: MobileLibraryCount[] =
    activeFilterCount > 0
      ? [{ n: items.length, text: t("library.stats.shownOf", { shown: items.length, total: t(statKey, { count: inTabCount }) }) }]
      : [
          { n: totals.movie, text: t("library.stats.movie", { count: totals.movie }) },
          { n: totals.tv, text: t("library.stats.series", { count: totals.tv }) },
        ];

  const clear = () => {
    dispatch({ type: "set", filters: { ...EMPTY_LIBRARY_FILTERS, query: filters.query } });
    setFacets({});
  };

  const openFilter = () => {
    setDraft({ filters, facets });
    setSheet("filter");
  };
  const apply = () => {
    dispatch({ type: "set", filters: draft.filters });
    setFacets(draft.facets);
    setSheet(null);
  };
  const setDraftFilters = (patch: Partial<LibraryFilters>) => setDraft((current) => ({ ...current, filters: { ...current.filters, ...patch } }));
  const more = (count: number) => t("library.filters.more", { count });
  const sortSection = (
    <MobileLibrarySheetSection label={t("library.sort.title")} testID="library-sort-section">
      <MobileLibraryPills
        pills={SORTS.map((sortBy) => ({
          id: sortBy,
          label: t(`library.sort.${sortBy}`),
          on: prefs.sortBy === sortBy,
          onPress: () => updateLibraryTabPrefs(tab, { sortBy }),
          testID: `library-sort-${sortBy}`,
        }))}
      />
      <MobileLibraryPills
        pills={DIRECTIONS.map((sortDirection) => ({
          id: sortDirection,
          label: t(`library.sort.${sortDirection}`),
          on: prefs.sortDirection === sortDirection,
          onPress: () => updateLibraryTabPrefs(tab, { sortDirection }),
          testID: `library-sort-${sortDirection}`,
        }))}
      />
    </MobileLibrarySheetSection>
  );
  const switcher = (
    <MobileLibrarySegmented
      options={[
        { id: "movies" as const, label: t("library.scopes.movies"), testID: "library-scope-movies", icon: <Film size={15} color={scope === "movies" ? theme.accentTextHex : theme.colors.textMuted} /> },
        { id: "tv" as const, label: t("library.scopes.tv"), testID: "library-scope-tv", icon: <Tv size={15} color={scope === "tv" ? theme.accentTextHex : theme.colors.textMuted} /> },
      ]}
      value={scope}
      onChange={changeScope}
    />
  );

  return (
    <View style={styles.page}>
      <View style={styles.body}>
        <MobileLibraryHeader
          switcher={switcher}
          counts={counts}
          filterCount={activeFilterCount}
          onOpenFilter={openFilter}
          onOpenSort={() => setSheet("sort")}
          onClear={clear}
          labels={{
            filter: t("library.filters.title"),
            sort: t("library.sort.button"),
            clear: t("library.filters.clearShort"),
            filterActive: (count) => t("library.filters.active", { count }),
          }}
        />

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

        <MobileLibrarySheet
          visible={sheet === "filter"}
          onClose={() => setSheet(null)}
          title={t("library.filters.title")}
          testID="library-filter-sheet"
          footer={
            <MobileLibrarySheetButtons
              secondary={{ label: t("library.filters.reset"), onPress: () => setDraft({ filters: { ...EMPTY_LIBRARY_FILTERS, query: filters.query }, facets: {} }), testID: "library-filter-reset" }}
              primary={{ label: t("library.filters.apply"), onPress: apply, testID: "library-filter-apply" }}
            />
          }
        >
          {genreOptions.length >= MIN_CHOICES ? (
            <MobileLibrarySheetSection label={t("library.filters.genres.title")} testID="library-filter-genres">
              <MobileLibraryFilterPicker
                options={genreOptions}
                selected={draft.filters.genres}
                onChange={(genres) => setDraftFilters({ genres })}
                searchPlaceholder={t("library.filters.genres.search")}
                emptyText={t("library.filters.genres.empty")}
                moreLabel={more}
                testID="library-genres-picker"
              />
            </MobileLibrarySheetSection>
          ) : null}
          {actorOptions.length >= MIN_CHOICES ? (
            <MobileLibrarySheetSection label={t("library.filters.actors.title")} testID="library-filter-actors">
              <MobileLibraryFilterPicker
                options={actorOptions}
                selected={draft.filters.actors}
                onChange={(actors) => setDraftFilters({ actors })}
                searchPlaceholder={t("library.filters.actors.search")}
                emptyText={t("library.filters.actors.empty")}
                moreLabel={more}
                testID="library-actors-picker"
              />
            </MobileLibrarySheetSection>
          ) : null}
          {facetSections.map(({ facet, options }) => (
            <MobileLibrarySheetSection key={facet} label={t(`library.filters.${facet}.title`)} testID={`library-filter-${facet}`}>
              <MobileLibraryFilterPicker
                options={options}
                selected={draft.facets[facet] ?? []}
                onChange={(next) => setDraft((current) => ({ ...current, facets: { ...current.facets, [facet]: next } }))}
                searchPlaceholder={t(`library.filters.${facet}.search`)}
                emptyText={t(`library.filters.${facet}.empty`)}
                moreLabel={more}
                testID={`library-${facet}-picker`}
              />
            </MobileLibrarySheetSection>
          ))}
          <MobileLibrarySheetSection label={t("library.filters.showOnly")} testID="library-filter-show-only">
            <MobileLibraryPills
              pills={[
                {
                  id: "downloaded",
                  label: t("library.sheet.downloadedOnly"),
                  on: draft.filters.downloadedOnly,
                  onPress: () => setDraftFilters({ downloadedOnly: !draft.filters.downloadedOnly }),
                  testID: "library-filter-downloaded",
                },
              ]}
            />
          </MobileLibrarySheetSection>
        </MobileLibrarySheet>
        <MobileLibrarySheet
          visible={sheet === "sort"}
          onClose={() => setSheet(null)}
          title={t("library.sort.button")}
          testID="library-sort-sheet"
          footer={<MobileLibrarySheetButtons primary={{ label: t("library.sort.done"), onPress: () => setSheet(null), testID: "library-sort-done" }} />}
        >
          {sortSection}
        </MobileLibrarySheet>
      </View>
    </View>
  );
});
LibraryScreen.displayName = "LibraryScreen";

const styles = StyleSheet.create({
  page: { flex: 1, paddingTop: 8, gap: 12 },
  body: { flex: 1, gap: 12, marginBottom: 8 },
  error: { fontSize: 12, color: theme.colors.danger },
  grid: { flex: 1 },
});
