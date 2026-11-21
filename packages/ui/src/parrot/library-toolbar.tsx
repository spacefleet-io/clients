/**
 * The Library page's one slim row (PAR-LIB-06), shared by Parrot's browser-engine apps (desktop renderer and web
 * player) and drawn by the row Badger uses too (`LibraryRow`, Chris 2026-11-20: "same row design for both apps"): the
 * Albums / Artists / Songs switch, a divider and the quiet counts on the left; on the right a Filter button opening the
 * tab's filters in a panel, then Sort opening the tab's sorts. Parrot has one view per tab, so no view button. The row
 * stays pinned under the top bar while the page scrolls. No title and no search box: the app-wide search (Ctrl/Cmd+K)
 * finds music.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import {
  countParrotLibraryFilters,
  parrotLibraryDecadeOptions,
  parrotLibraryGenreOptions,
  parseParrotLibraryPrefs,
  PARROT_LIBRARY_FILTERS,
  PARROT_LIBRARY_PREFS_STORAGE_KEY,
  PARROT_LIBRARY_SORTS,
  PARROT_LIBRARY_TABS,
  shownParrotAlbums,
  shownParrotArtists,
  shownParrotSongs,
  type ListeningHistory,
  type ParrotLibraryAlbumFacts,
  type ParrotLibraryArtistFacts,
  type ParrotLibraryFilterKind,
  type ParrotLibraryFilters,
  type ParrotLibraryPrefs,
  type ParrotLibrarySongFacts,
  type ParrotLibrarySort,
  type ParrotLibraryTab,
  type ParrotLibraryTabPrefs,
} from "@space/parrot-core";
import type { ParrotShellKey } from "@space/parrot-core/shell-strings";
import {
  LibraryFilterButton,
  LibraryModal,
  LibraryModalButtons,
  LibraryModalSection,
  LibraryPills,
  LibraryRow,
  LibrarySegmented,
  LibrarySortButton,
  type LibraryCount,
} from "../library-row";

// Every user of the picks reads the same value: Home's "Recently added" "See all" (PAR-HOME-01) picks "Recently
// added" for the library's Albums tab, which is another component.
const prefsListeners = new Set<() => void>();
let prefsWithoutStorage: string | null = null;
let cached: { raw: string | null; prefs: ParrotLibraryPrefs } | null = null;
// Before the pinned row (2026-11-20) only Albums had a pick, under "parrot.albumSort": until the user picks anew, it
// still opens Albums in that order (an unknown value falls back to the default like any stored pick).
const LEGACY_ALBUM_SORT_KEY = "parrot.albumSort";
const readStoredPrefs = (storage: Storage): string | null => {
  const raw = storage.getItem(PARROT_LIBRARY_PREFS_STORAGE_KEY);
  if (raw !== null) return raw;
  const legacy = storage.getItem(LEGACY_ALBUM_SORT_KEY);
  return legacy === null ? null : JSON.stringify({ albums: { sort: legacy, filters: {} } });
};
const readPrefs = (): ParrotLibraryPrefs => {
  const raw = globalThis.localStorage ? readStoredPrefs(globalThis.localStorage) : prefsWithoutStorage;
  // useSyncExternalStore needs the same object while nothing changed.
  if (!cached || cached.raw !== raw) cached = { raw, prefs: parseParrotLibraryPrefs(raw) };
  return cached.prefs;
};
const subscribePrefs = (listener: () => void) => {
  prefsListeners.add(listener);
  return () => void prefsListeners.delete(listener);
};
const writeTabPrefs = <T extends ParrotLibraryTab>(tab: T, next: ParrotLibraryTabPrefs<T>) => {
  const raw = JSON.stringify({ ...readPrefs(), [tab]: next });
  console.info("[parrot-library] picks", JSON.stringify({ tab, sort: next.sort, filters: next.filters }));
  if (globalThis.localStorage) globalThis.localStorage.setItem(PARROT_LIBRARY_PREFS_STORAGE_KEY, raw);
  else prefsWithoutStorage = raw;
  for (const listener of prefsListeners) listener();
};

/**
 * Each tab's sort and filters, kept in the browser's storage so the library opens on the user's last picks; a tab's
 * picks are its own (picking a sort on Songs leaves Albums as it was).
 */
export function useParrotLibraryPrefs(): [ParrotLibraryPrefs, <T extends ParrotLibraryTab>(tab: T, next: ParrotLibraryTabPrefs<T>) => void] {
  return [useSyncExternalStore(subscribePrefs, readPrefs, readPrefs), writeTabPrefs];
}

/**
 * One tab's lists as the row's picks leave them, for the desktop and the web player alike: only the open tab's list
 * is worked out (the others come back empty), with what its Genre and Decade filters offer and whether any filter is on.
 */
export function useParrotLibraryShown<A extends ParrotLibraryAlbumFacts, R extends ParrotLibraryArtistFacts, S extends ParrotLibrarySongFacts>({
  tab,
  albums,
  artists,
  songs,
  history,
  likedSongIds,
}: {
  tab: ParrotLibraryTab;
  albums: readonly A[];
  artists: readonly R[];
  songs: readonly S[];
  history: ListeningHistory;
  likedSongIds: ReadonlySet<string>;
}) {
  const [prefs, setPrefs] = useParrotLibraryPrefs();
  const context = useMemo(() => ({ albums, songs, history, likedSongIds }), [albums, songs, history, likedSongIds]);
  const tabPrefs = prefs[tab];
  const shownAlbums = useMemo(() => (tab === "albums" ? shownParrotAlbums(albums, prefs.albums, context) : []), [tab, albums, prefs.albums, context]);
  const shownArtists = useMemo(() => (tab === "artists" ? shownParrotArtists(artists, prefs.artists, context) : []), [tab, artists, prefs.artists, context]);
  const shownSongs = useMemo(() => (tab === "songs" ? shownParrotSongs(songs, prefs.songs, context) : []), [tab, songs, prefs.songs, context]);
  const genres = useMemo(() => parrotLibraryGenreOptions(tab, context), [tab, context]);
  const decades = useMemo(() => parrotLibraryDecadeOptions(tab, context), [tab, context]);
  return {
    prefs: tabPrefs,
    setPrefs: (next: ParrotLibraryTabPrefs) => setPrefs(tab, next as never),
    filtered: countParrotLibraryFilters(tabPrefs.filters) > 0,
    shownAlbums,
    shownArtists,
    shownSongs,
    shownCount: tab === "albums" ? shownAlbums.length : tab === "artists" ? shownArtists.length : shownSongs.length,
    genres,
    decades,
  };
}

/** Every sort's name, shared by the tabs that offer it ("Title" on Albums and Songs). */
export type ParrotLibrarySortLabels = Record<ParrotLibrarySort, string>;

export type ParrotLibraryToolbarLabels = {
  /** The switch's name for assistive tech ("Library"), the same whichever tab is open. */
  tabsLabel: string;
  tabs: Record<ParrotLibraryTab, string>;
  /** The Sort button's word. */
  sort: string;
  /** The Sort panel's title ("Sort by"). */
  sortTitle: string;
  /** Each sort's name in the Sort panel, with its direction where the name alone leaves it open ("Title (A–Z)"). */
  sorts: ParrotLibrarySortLabels;
  /** The Filter button's word and the Filter panel's title. */
  filter: string;
  filters: Record<ParrotLibraryFilterKind, string>;
  /** The panel's heading over the on / off filters (Liked, With lyrics, Lossless). */
  showOnly: string;
  /** "1990s". */
  decade: (decade: number) => string;
  /** The row's link that drops every filter. */
  clear: string;
  /** The Filter panel's buttons: Reset empties the draft, Apply keeps it. */
  reset: string;
  apply: string;
  /** The Sort panel's button. */
  done: string;
  /** The panels' corner close button, for assistive tech. */
  close: string;
};

/** The row's words from the shell's shared words (`@space/parrot-core/shell-strings`), in the app's language. */
export const parrotLibraryToolbarLabels = (t: (key: ParrotShellKey, vars?: Record<string, string | number>) => string): ParrotLibraryToolbarLabels => {
  const names: ParrotLibrarySortLabels = {
    recent: t("library.sortRecent"),
    played: t("library.sortPlayed"),
    title: t("library.sortTitle"),
    artist: t("library.sortArtist"),
    year: t("library.sortYear"),
    name: t("library.sortName"),
    plays: t("library.sortPlays"),
    albums: t("library.sortAlbumCount"),
    songs: t("library.sortSongCount"),
    album: t("library.sortAlbum"),
    duration: t("library.sortDuration"),
  };
  // "Recently added", "Most played", "Longest first" already say which way they run; the names sorted A to Z and the
  // year (newest first) say it in the panel.
  const az = (sort: string) => t("library.sortAz", { sort });
  return {
    tabsLabel: t("library.title"),
    tabs: { albums: t("library.albums"), artists: t("library.artists"), songs: t("library.songs") },
    sort: t("library.sort"),
    sortTitle: t("library.sortHeading"),
    sorts: { ...names, title: az(names.title), artist: az(names.artist), name: az(names.name), album: az(names.album), year: t("library.sortNewest", { sort: names.year }) },
    filter: t("library.filter"),
    filters: {
      genre: t("library.filterGenre"),
      decade: t("library.filterDecade"),
      liked: t("library.filterLiked"),
      lyrics: t("library.filterLyrics"),
      lossless: t("library.filterLossless"),
    },
    showOnly: t("library.filterShowOnly"),
    decade: (decade) => t("library.decade", { decade }),
    clear: t("library.clearFilters"),
    reset: t("library.filterReset"),
    apply: t("library.filterApply"),
    done: t("library.sortDone"),
    close: t("library.close"),
  };
};

export type ParrotLibraryToolbarProps = {
  tab: ParrotLibraryTab;
  onTab: (tab: ParrotLibraryTab) => void;
  counts: LibraryCount[];
  prefs: ParrotLibraryTabPrefs;
  onPrefs: (next: ParrotLibraryTabPrefs) => void;
  /** What the Genre and Decade filters offer on this tab; a filter with nothing to offer is left out unless it is on. */
  genres: string[];
  decades: number[];
  labels: ParrotLibraryToolbarLabels;
  /**
   * Where the row pins, against the top of its scroller's content: the height covered by the app's top bar (64 when
   * the window scrolls under a fixed bar), or minus the scroller's top padding when the page scrolls in its own padded
   * box under the bar (-32 on Parrot desktop), so the row rides flush with the box's top edge.
   */
  pinTop?: number;
  /** Extra classes for the pinned row, to reach the page's side edges with its background. */
  className?: string;
};

type ParrotFlagFilter = "liked" | "lyrics" | "lossless";
const isFlag = (kind: ParrotLibraryFilterKind): kind is ParrotFlagFilter => kind === "liked" || kind === "lyrics" || kind === "lossless";

/** The Library page's pinned row (PAR-LIB-06). */
export function ParrotLibraryToolbar({ tab, onTab, counts, prefs, onPrefs, genres, decades, labels, pinTop, className }: ParrotLibraryToolbarProps) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  // The panel edits a draft: Apply keeps it, Reset empties it, closing the panel drops it (as in Badger).
  const [draft, setDraft] = useState<ParrotLibraryFilters>({});
  const { filters } = prefs;
  const active = countParrotLibraryFilters(filters);
  const setFilters = (next: ParrotLibraryFilters) => onPrefs({ ...prefs, filters: next });
  const openFilters = (open: boolean) => {
    if (open) setDraft(filters);
    console.info("[parrot-library] filter panel", open ? "open" : "closed", JSON.stringify({ tab, filters }));
    setFilterOpen(open);
  };
  const draftWith = <K extends keyof ParrotLibraryFilters>(kind: K, value: ParrotLibraryFilters[K] | undefined) => {
    const next = { ...draft };
    if (value === undefined) delete next[kind];
    else next[kind] = value;
    setDraft(next);
  };

  const kinds = PARROT_LIBRARY_FILTERS[tab] as readonly ParrotLibraryFilterKind[];
  // A pick list with nothing to offer (no song carries a genre) is left out, unless a pick is on: it stays reachable
  // (to clear it) even once the library no longer offers it.
  const genreOptions = draft.genre && !genres.includes(draft.genre) ? [draft.genre, ...genres] : genres;
  const decadeOptions = draft.decade !== undefined && !decades.includes(draft.decade) ? [draft.decade, ...decades] : decades;
  const flags = kinds.filter(isFlag);
  // With no flag and no pick list to show (Artists in a library without genre tags), the panel would open empty.
  const offersFilters = flags.length > 0 || active > 0 || (kinds.includes("genre") && genres.length > 0) || (kinds.includes("decade") && decades.length > 0);
  const sorts = PARROT_LIBRARY_SORTS[tab] as readonly ParrotLibrarySort[];

  return (
    <LibraryRow
      pinTop={pinTop}
      className={className}
      logTag="parrot-library"
      counts={counts}
      switcher={
        <LibrarySegmented
          ariaLabel={labels.tabsLabel}
          value={tab}
          onChange={onTab}
          testId="library-tabs"
          options={PARROT_LIBRARY_TABS.map((value) => ({ id: value, label: labels.tabs[value], testId: `library-chip-${value}` }))}
        />
      }
      trailing={
        <>
          <LibraryFilterButton
            label={labels.filter}
            clearLabel={labels.clear}
            count={active}
            disabled={!offersFilters}
            onOpen={() => openFilters(true)}
            onClear={() => setFilters({})}
          />
          <LibrarySortButton label={labels.sort} onOpen={() => setSortOpen(true)} />
          <LibraryModal
            open={filterOpen}
            onOpenChange={openFilters}
            title={labels.filter}
            closeLabel={labels.close}
            testId="library-filter-modal"
            footer={
              <LibraryModalButtons
                secondary={{ label: labels.reset, onClick: () => setDraft({}), testId: "library-filter-reset" }}
                primary={{
                  label: labels.apply,
                  onClick: () => {
                    setFilters(draft);
                    openFilters(false);
                  },
                  testId: "library-filter-apply",
                }}
              />
            }
          >
            {kinds.includes("genre") && genreOptions.length > 0 && (
              <LibraryModalSection label={labels.filters.genre} testId="library-filter-genre">
                <LibraryPills
                  pills={genreOptions.map((genre) => ({
                    id: genre,
                    label: genre,
                    on: draft.genre === genre,
                    onClick: () => draftWith("genre", draft.genre === genre ? undefined : genre),
                  }))}
                />
              </LibraryModalSection>
            )}
            {kinds.includes("decade") && decadeOptions.length > 0 && (
              <LibraryModalSection label={labels.filters.decade} testId="library-filter-decade">
                <LibraryPills
                  pills={decadeOptions.map((decade) => ({
                    id: String(decade),
                    label: labels.decade(decade),
                    on: draft.decade === decade,
                    onClick: () => draftWith("decade", draft.decade === decade ? undefined : decade),
                  }))}
                />
              </LibraryModalSection>
            )}
            {flags.length > 0 && (
              <LibraryModalSection label={labels.showOnly} testId="library-filter-flags">
                <LibraryPills
                  pills={flags.map((kind) => ({
                    id: kind,
                    label: labels.filters[kind],
                    on: !!draft[kind],
                    onClick: () => draftWith(kind, draft[kind] ? undefined : true),
                    testId: `library-filter-${kind}`,
                  }))}
                />
              </LibraryModalSection>
            )}
          </LibraryModal>
          <LibraryModal
            open={sortOpen}
            onOpenChange={setSortOpen}
            title={labels.sortTitle}
            closeLabel={labels.close}
            testId="library-sort-modal"
            footer={<LibraryModalButtons primary={{ label: labels.done, onClick: () => setSortOpen(false), testId: "library-sort-done" }} />}
          >
            <LibraryPills
              pills={sorts.map((sort) => ({
                id: sort,
                label: labels.sorts[sort],
                on: sort === prefs.sort,
                onClick: () => onPrefs({ ...prefs, sort } as ParrotLibraryTabPrefs),
                testId: `library-sort-${sort}`,
              }))}
            />
          </LibraryModal>
        </>
      }
    />
  );
}
