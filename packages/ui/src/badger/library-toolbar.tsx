import { useState } from "react";
import { BadgerFilterPicker, BadgerSortMenu, type BadgerMultiSelectOption } from "./library-menus";
import { LibraryFilterButton, LibraryModal, LibraryModalButtons, LibraryModalSection, LibrarySortButton, LibraryViewCycleButton, type LibraryViewOption } from "../library-row";
import { LIBRARY_FACETS, LIBRARY_WATCH_STATES, countLibraryFacetSelection, type LibraryFacet, type LibraryFacetSelection } from "@space/shared/libraryFacets";
import { formatMediaLanguageLabelForUi } from "@space/shared/mediaLanguageDisplay";

export type FilterListLabels = { title: string; search: string; empty: string };

const EMPTY_FACETS: LibraryFacetSelection = Object.freeze({});

/** A list drawn from the library shows only with at least this many choices. */
const MIN_CHOICES = 2;

/** One extra Filter section: which facet it picks, its texts and the keys the library holds (with their labels). */
export type BadgerLibraryFacetSection = { facet: LibraryFacet; labels: FilterListLabels; options: BadgerMultiSelectOption[] };

export type BadgerLibraryControlsLabels = {
  filter: string;
  clear: string;
  reset: string;
  apply: string;
  sort: string;
  sortTitle: string;
  sortBy: string;
  sortDirection: string;
  directionText: string;
  done: string;
  close: string;
  genres: FilterListLabels;
  actors: FilterListLabels;
  /** The view button's tooltip, given the next view's label. */
  nextView: (label: string) => string;
  /** The "+N more" chip of a long Filter list, given N. */
  moreChoices: (count: number) => string;
};

/**
 * UX-LIB-01: the right-hand group of the shared library row (`LibraryRow`) in Badger, for the desktop app and the web
 * player — the Filter button (count badge, plus a "Clear" link while filters are on) opening the panel whose Genres /
 * Actors (and UX-LIB-03 quality, director, audio, subtitles and watch-state) draft Apply commits and Reset empties, a
 * Sort button opening the sort options with the asc/desc toggle, and the one view button that cycles the views. The
 * quiet counts sit on the row's left, after the switch (Chris 2026-11-20).
 */
export function BadgerLibraryControls<S extends string, V extends string>({
  labels,
  genreOptions,
  actorOptions,
  genres,
  actors,
  facetSections = [],
  facets = EMPTY_FACETS,
  onFiltersChange,
  onFilterOpenChange,
  sortOptions,
  sortBy,
  onSortByChange,
  sortDirection,
  onToggleSortDirection,
  viewOptions,
  view,
  onViewChange,
  disabled = false,
}: {
  labels: BadgerLibraryControlsLabels;
  genreOptions: BadgerMultiSelectOption[];
  actorOptions: BadgerMultiSelectOption[];
  genres: string[];
  actors: string[];
  /** UX-LIB-03: the extra Filter sections (quality, director, audio, subtitles, watch state) in display order. */
  facetSections?: ReadonlyArray<BadgerLibraryFacetSection>;
  facets?: LibraryFacetSelection;
  onFiltersChange: (genres: string[], actors: string[], facets: LibraryFacetSelection) => void;
  /** Lets the page build costly options (the cast) only while the modal is open. */
  onFilterOpenChange?: (open: boolean) => void;
  sortOptions: { value: S; label: string }[];
  sortBy: S;
  onSortByChange: (value: S) => void;
  sortDirection: "asc" | "desc";
  onToggleSortDirection: () => void;
  viewOptions: ReadonlyArray<LibraryViewOption<V>>;
  view: V;
  onViewChange: (view: V) => void;
  disabled?: boolean;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const [draftGenres, setDraftGenres] = useState<string[]>([]);
  const [draftActors, setDraftActors] = useState<string[]>([]);
  const [draftFacets, setDraftFacets] = useState<LibraryFacetSelection>(EMPTY_FACETS);
  const activeCount = genres.length + actors.length + countLibraryFacetSelection(facets);
  const openFilters = (open: boolean) => {
    if (open) {
      setDraftGenres(genres);
      setDraftActors(actors);
      setDraftFacets(facets);
    }
    setFilterOpen(open);
    onFilterOpenChange?.(open);
  };

  return (
    <>
      <LibraryFilterButton
        label={labels.filter}
        clearLabel={labels.clear}
        count={activeCount}
        disabled={disabled}
        onOpen={() => openFilters(true)}
        onClear={() => onFiltersChange([], [], EMPTY_FACETS)}
      />
      <LibrarySortButton label={labels.sort} disabled={disabled} onOpen={() => setSortOpen(true)} />
      <LibraryViewCycleButton options={viewOptions} value={view} onChange={onViewChange} nextLabel={(next) => labels.nextView(next.label)} />
      <LibraryModal
        open={filterOpen}
        onOpenChange={openFilters}
        title={labels.filter}
        closeLabel={labels.close}
        testId="library-filter-modal"
        footer={
          <LibraryModalButtons
            secondary={{
              label: labels.reset,
              onClick: () => {
                setDraftGenres([]);
                setDraftActors([]);
                setDraftFacets(EMPTY_FACETS);
              },
              testId: "library-filter-reset",
            }}
            primary={{
              label: labels.apply,
              onClick: () => {
                onFiltersChange(draftGenres, draftActors, draftFacets);
                openFilters(false);
              },
              testId: "library-filter-apply",
            }}
          />
        }
      >
        {/* A list drawn from the library shows only with two or more choices (one choice filters nothing). */}
        {genreOptions.length >= MIN_CHOICES ? (
          <LibraryModalSection label={labels.genres.title} testId="library-filter-genres">
            <BadgerFilterPicker searchPlaceholder={labels.genres.search} emptyText={labels.genres.empty} moreLabel={labels.moreChoices} options={genreOptions} selected={draftGenres} onChange={setDraftGenres} />
          </LibraryModalSection>
        ) : null}
        {actorOptions.length >= MIN_CHOICES ? (
          <LibraryModalSection label={labels.actors.title} testId="library-filter-actors">
            <BadgerFilterPicker searchPlaceholder={labels.actors.search} emptyText={labels.actors.empty} moreLabel={labels.moreChoices} options={actorOptions} selected={draftActors} onChange={setDraftActors} />
          </LibraryModalSection>
        ) : null}
        {facetSections.map((section) => (
          <LibraryModalSection key={section.facet} label={section.labels.title} testId={`library-filter-${section.facet}`}>
            <BadgerFilterPicker
              searchPlaceholder={section.labels.search}
              emptyText={section.labels.empty}
              moreLabel={labels.moreChoices}
              options={section.options}
              selected={draftFacets[section.facet] ?? []}
              onChange={(next) => setDraftFacets((prev) => ({ ...prev, [section.facet]: next }))}
            />
          </LibraryModalSection>
        ))}
      </LibraryModal>
      <LibraryModal
        open={sortOpen}
        onOpenChange={setSortOpen}
        title={labels.sortTitle}
        closeLabel={labels.close}
        testId="library-sort-modal"
        footer={<LibraryModalButtons primary={{ label: labels.done, onClick: () => setSortOpen(false), testId: "library-sort-done" }} />}
      >
        <BadgerSortMenu
          byLabel={labels.sortBy}
          directionLabel={labels.sortDirection}
          options={sortOptions}
          value={sortBy}
          onChange={onSortByChange}
          direction={sortDirection}
          directionText={labels.directionText}
          onToggleDirection={onToggleSortDirection}
        />
      </LibraryModal>
    </>
  );
}

/**
 * UX-LIB-03: the extra Filter sections from the keys a library holds (`libraryFacetOptions`), labelled with the app's
 * `library.filters.*` strings — the desktop app and the web player share these keys, so both read the same.
 */
export function libraryFacetSections(
  options: Record<LibraryFacet, readonly string[]>,
  t: (key: string) => string,
  uiLanguage: string,
): BadgerLibraryFacetSection[] {
  const undefinedLanguage = t("library.filters.undefinedLanguage");
  const optionLabel = (facet: LibraryFacet, key: string): string => {
    switch (facet) {
      case "qualities":
        return key === "sd" ? t("library.filters.quality.sd") : key === "4k" || key === "2k" ? key.toUpperCase() : key;
      case "watchStates":
        return t(`library.filters.watchState.${key}`);
      case "directors":
        return key.replace(/\b\w/g, (letter) => letter.toUpperCase());
      default:
        return formatMediaLanguageLabelForUi(key, uiLanguage, undefinedLanguage);
    }
  };
  // Watch state is a fixed set, offered whole; the other kinds come from the library and need two choices to filter.
  return LIBRARY_FACETS.filter((facet) => facet === "watchStates" || options[facet].length >= MIN_CHOICES).map((facet) => ({
    facet,
    labels: {
      title: t(`library.filters.${facet}.title`),
      search: t(`library.filters.${facet}.search`),
      empty: t(`library.filters.${facet}.empty`),
    },
    options: (facet === "watchStates" ? LIBRARY_WATCH_STATES : options[facet]).map((key) => ({ value: key, label: optionLabel(facet, key) })),
  }));
}
