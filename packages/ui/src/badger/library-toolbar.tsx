import { useState, type ReactNode } from "react";
import { Filter, SortAsc } from "lucide-react";
import { Button } from "../button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../dialog";
import { BadgerSelectButton } from "./components";
import { BadgerMultiSelect, BadgerSortMenu, type BadgerMultiSelectOption } from "./library-menus";
import { LIBRARY_FACETS, countLibraryFacetSelection, type LibraryFacet, type LibraryFacetSelection } from "@space/shared/libraryFacets";
import { formatMediaLanguageLabelForUi } from "@space/shared/mediaLanguageDisplay";

/**
 * UX-LIB-01: the library row's Filter / Sort modal. The body is the app's (filter lists, sort options); `footer`
 * holds its buttons (Filter: Reset + Apply; Sort: Done).
 */
export function BadgerLibraryModal({
  open,
  onOpenChange,
  title,
  closeLabel,
  children,
  footer,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  closeLabel: string;
  children: ReactNode;
  footer: ReactNode;
  testId?: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" closeLabel={closeLabel} data-testid={testId}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {/* The Filter modal holds up to seven lists (UX-LIB-03): its body scrolls, the title and buttons stay put. */}
        <div className="-mr-2 max-h-[65vh] space-y-5 overflow-y-auto pr-2">{children}</div>
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One labelled group inside a library modal (Genres, Actors, Sort by). */
export function BadgerLibraryModalSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="text-[11px] font-black uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      {children}
    </section>
  );
}

/** The modal footer's secondary and primary buttons. */
export function BadgerLibraryModalButtons({
  secondary,
  primary,
}: {
  secondary?: { label: string; onClick: () => void; testId?: string };
  primary: { label: string; onClick: () => void; testId?: string };
}) {
  return (
    <>
      {secondary ? (
        <Button type="button" variant="ghost" onClick={secondary.onClick} data-testid={secondary.testId}>
          {secondary.label}
        </Button>
      ) : null}
      <Button type="button" onClick={primary.onClick} data-testid={primary.testId}>
        {primary.label}
      </Button>
    </>
  );
}

type ViewCycleOption<T extends string> = { id: T; label: string; icon: ReactNode };

/**
 * UX-LIB-01: one 38px button for the library view. Its icon shows the current view; a click moves to the next one
 * (posters → compact → details → posters), which its tooltip names.
 */
export function BadgerViewCycleButton<T extends string>({
  options,
  value,
  onChange,
  nextLabel,
  testId,
}: {
  options: ReadonlyArray<ViewCycleOption<T>>;
  value: T;
  onChange: (id: T) => void;
  /** The tooltip for the next view, e.g. "Switch to Compact grid". */
  nextLabel: (next: ViewCycleOption<T>) => string;
  testId?: string;
}) {
  const index = Math.max(0, options.findIndex((option) => option.id === value));
  const current = options[index]!;
  const next = options[(index + 1) % options.length]!;
  const label = nextLabel(next);
  return (
    <button
      type="button"
      data-testid={testId}
      data-view={current.id}
      aria-label={label}
      title={label}
      className="flex h-[38px] w-10 shrink-0 items-center justify-center rounded-[10px] border border-border bg-secondary/50 text-foreground transition hover:border-primary/60 hover:bg-secondary [&_svg]:h-4 [&_svg]:w-4"
      onClick={() => onChange(next.id)}
    >
      {current.icon}
    </button>
  );
}

export type FilterListLabels = { title: string; placeholder: string; search: string; empty: string };

const EMPTY_FACETS: LibraryFacetSelection = Object.freeze({});

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
};

/**
 * UX-LIB-01: the library row's controls, shared by the desktop app and the web player — a Filter button (count badge,
 * plus a "Clear" link while filters are on) opening a modal whose Genres / Actors (and UX-LIB-03 quality, director,
 * audio, subtitles and watch-state) draft Apply commits and Reset empties,
 * a Sort button opening the sort options with the asc/desc toggle, and the one view button that cycles the views.
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
  viewOptions: ReadonlyArray<ViewCycleOption<V>>;
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
      <BadgerSelectButton
        icon={<Filter />}
        label={labels.filter}
        count={activeCount}
        active={activeCount > 0}
        disabled={disabled}
        onClick={() => openFilters(true)}
        testId="library-filter-button"
      />
      {activeCount > 0 ? (
        <button
          type="button"
          className="shrink-0 text-xs font-semibold text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => onFiltersChange([], [], EMPTY_FACETS)}
          data-testid="library-filter-clear"
        >
          {labels.clear}
        </button>
      ) : null}
      <BadgerSelectButton icon={<SortAsc />} label={labels.sort} disabled={disabled} onClick={() => setSortOpen(true)} testId="library-sort-button" />
      <BadgerViewCycleButton options={viewOptions} value={view} onChange={onViewChange} nextLabel={(next) => labels.nextView(next.label)} testId="library-view-cycle" />
      <BadgerLibraryModal
        open={filterOpen}
        onOpenChange={openFilters}
        title={labels.filter}
        closeLabel={labels.close}
        testId="library-filter-modal"
        footer={
          <BadgerLibraryModalButtons
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
        <BadgerLibraryModalSection label={labels.genres.title}>
          <BadgerMultiSelect
            placeholder={labels.genres.placeholder}
            searchPlaceholder={labels.genres.search}
            emptyText={labels.genres.empty}
            options={genreOptions}
            selected={draftGenres}
            onChange={setDraftGenres}
          />
        </BadgerLibraryModalSection>
        <BadgerLibraryModalSection label={labels.actors.title}>
          <BadgerMultiSelect
            placeholder={labels.actors.placeholder}
            searchPlaceholder={labels.actors.search}
            emptyText={labels.actors.empty}
            options={actorOptions}
            selected={draftActors}
            onChange={setDraftActors}
          />
        </BadgerLibraryModalSection>
        {facetSections.map((section) => (
          <BadgerLibraryModalSection key={section.facet} label={section.labels.title}>
            <div data-testid={`library-filter-${section.facet}`}>
              <BadgerMultiSelect
                placeholder={section.labels.placeholder}
                searchPlaceholder={section.labels.search}
                emptyText={section.labels.empty}
                options={section.options}
                selected={[...(draftFacets[section.facet] ?? [])]}
                onChange={(next) => setDraftFacets((prev) => ({ ...prev, [section.facet]: next }))}
              />
            </div>
          </BadgerLibraryModalSection>
        ))}
      </BadgerLibraryModal>
      <BadgerLibraryModal
        open={sortOpen}
        onOpenChange={setSortOpen}
        title={labels.sortTitle}
        closeLabel={labels.close}
        testId="library-sort-modal"
        footer={<BadgerLibraryModalButtons primary={{ label: labels.done, onClick: () => setSortOpen(false), testId: "library-sort-done" }} />}
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
      </BadgerLibraryModal>
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
  return LIBRARY_FACETS.filter((facet) => options[facet].length > 0).map((facet) => ({
    facet,
    labels: {
      title: t(`library.filters.${facet}.title`),
      placeholder: t(`library.filters.${facet}.placeholder`),
      search: t(`library.filters.${facet}.search`),
      empty: t(`library.filters.${facet}.empty`),
    },
    options: options[facet].map((key) => ({ value: key, label: optionLabel(facet, key) })),
  }));
}
