/**
 * Badger's home and library pieces shared by the desktop renderer and the web player (REL-FAM-02), drawn from the
 * approved design (`badger-design-web/screens/desktop-{home,library,empty}.html`): the "Continue watching" hero card,
 * the row head, the poster grid and card, the slim library row (segmented toggle + search), the top-bar icon button
 * and the empty library. Texts arrive already translated and posters as elements, so each app keeps its own string
 * table and its own way of loading pictures.
 */
import type { ReactNode } from "react";
import { Check, Film, Filter, House, Info, LayoutGrid, Library, List, ListMusic, Play, Plus, Rows3, Search, Settings, SortAsc, Tv, User } from "lucide-react";
import { Button } from "../button";
import { GuardedItems } from "../render-boundary";
import { UNAVAILABLE_CLASS } from "../unavailable";
import { cn } from "../utils";
import { pillGhost, pillPrimary } from "../empty-library";

export { BadgerMenuPanel, BadgerMultiSelect, BadgerSortMenu, type BadgerMultiSelectOption } from "./library-menus";
export { BadgerLibraryList, type BadgerLibraryListRow } from "./library-list";
export { BadgerLibraryControls, BadgerLibraryModal, BadgerLibraryModalButtons, BadgerLibraryModalSection, BadgerViewCycleButton, libraryFacetSections, type BadgerLibraryControlsLabels, type BadgerLibraryFacetSection, type FilterListLabels } from "./library-toolbar";
export { BadgerPlaylistsView, type BadgerPlaylistEntry, type BadgerPlaylistsLabels } from "./playlists";

/** Seconds → "1h 18m" or "52m", the runtime in a title's meta line. */
export function formatBadgerRuntime(totalSeconds: number): string {
  const minutes = Math.max(1, Math.round(totalSeconds / 60));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`;
}


/** A thin amber progress line; `className` places it. */
function ProgressLine({ pct, className, track }: { pct: number; className?: string; track: string }) {
  return (
    <span className={cn("block h-1 rounded-sm", track, className)} aria-hidden>
      <i className="block h-full rounded-sm bg-primary" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </span>
  );
}

type ContinueWatchingHeroProps = {
  eyebrow: string;
  title: string;
  /** "1926 · 1h 18m · Comedy · Action · 37 min left": built by the app, empty parts left out. */
  meta: string;
  progressPct: number;
  /** The poster element, already sized to fill its 2:3 box. */
  poster: ReactNode;
  /** The same picture again, blurred behind the card; absent = no glow. */
  glowSrc?: string | null;
  resumeLabel: string;
  detailsLabel: string;
  onResume: () => void;
  onDetails: () => void;
  testId?: string;
};

/** The first thing on Home: the title the viewer was last watching, with Resume and Details (UX-HOME-01). */
export function BadgerContinueHero({ eyebrow, title, meta, progressPct, poster, glowSrc, resumeLabel, detailsLabel, onResume, onDetails, testId = "continue-hero" }: ContinueWatchingHeroProps) {
  return (
    <section
      className="relative overflow-hidden rounded-[var(--radius)] border border-[hsl(var(--border)/0.55)] bg-[linear-gradient(100deg,hsl(var(--card)/0.96)_0%,hsl(var(--card)/0.82)_45%,hsl(var(--card)/0.55)_100%)] p-6 shadow-[0_24px_60px_rgba(0,0,0,0.35)]"
      data-testid={testId}
    >
      {glowSrc ? (
        <img src={glowSrc} alt="" aria-hidden className="pointer-events-none absolute -right-20 -top-[120px] h-[560px] w-[760px] object-cover opacity-35 blur-[60px] saturate-[1.3]" />
      ) : null}
      <div className="relative flex items-center gap-7">
        <div className="relative aspect-[2/3] w-[150px] flex-none overflow-hidden rounded-lg bg-muted shadow-[0_12px_28px_rgba(0,0,0,0.4)]">{poster}</div>
        {/* The text uses the card's whole width; the title wraps to two lines before it is cut (UX-HOME-02). */}
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-black uppercase tracking-[0.14em] text-primary">{eyebrow}</div>
          <h1 className="mt-1.5 line-clamp-2 break-words text-[40px] font-semibold leading-[1.05] text-foreground" title={title} data-testid={`${testId}-title`}>
            {title}
          </h1>
          {meta ? <div className="mt-2 text-[15px] text-muted-foreground" data-testid={`${testId}-meta`}>{meta}</div> : null}
          <ProgressLine pct={progressPct} className="relative mt-3.5 max-w-[420px]" track="bg-[hsl(var(--foreground)/0.16)]" />
          <div className="mt-5 flex gap-2.5">
            <button type="button" className={pillPrimary} onClick={onResume} data-testid={`${testId}-resume`}>
              <Play className="h-4 w-4 fill-current" aria-hidden />
              {resumeLabel}
            </button>
            <button type="button" className={pillGhost} onClick={onDetails} data-testid={`${testId}-details`}>
              <Info className="h-4 w-4" aria-hidden />
              {detailsLabel}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/** A Home row's head: the row's name, and "See all" on the right when the row has a page of its own. */
export function BadgerRowHead({ title, seeAll, actions }: { title: ReactNode; seeAll?: { label: string; onClick: () => void }; actions?: ReactNode }) {
  return (
    <div className="mb-3.5 flex items-baseline justify-between gap-4">
      <h2 className="flex min-w-0 items-center gap-2 text-xl font-semibold text-foreground">{title}</h2>
      <div className="flex items-center gap-3">
        {actions}
        {seeAll ? (
          <Button variant="ghost" size="sm" className="text-[13px] text-muted-foreground" onClick={seeAll.onClick}>
            {seeAll.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Seven posters a row, as in the design: Home rows (gap 22px) and the library grid (gap 24px 22px). */
export function BadgerPosterGrid({ children, testId, variant = "library" }: { children: ReactNode; testId?: string; variant?: "row" | "library" }) {
  return (
    <ul className={cn("grid grid-cols-[repeat(7,minmax(0,1fr))]", variant === "row" ? "gap-[22px]" : "gap-x-[22px] gap-y-6")} data-testid={testId}>
      {/* UX-CRASH-01: a card that throws shows a placeholder in its cell; the other cards stay. */}
      <GuardedItems name={testId ?? "poster-grid"} className="aspect-[2/3]">
        {children}
      </GuardedItems>
    </ul>
  );
}

type PosterCardProps = {
  title: string;
  /** "1926 · Comedy": built by the app. */
  meta?: string;
  /** The poster element, already sized to fill its 2:3 box. */
  poster: ReactNode;
  watched?: boolean;
  /** 0..100; a line shows between 1 and 99. */
  progressPct?: number;
  onOpen: () => void;
  /** App-only extras drawn over the poster (hover buttons, badges); they sit above the open button. */
  overlay?: ReactNode;
  watchedLabel?: string;
  testId?: string;
  /** Extra attributes on the card, e.g. the media id the tests look for. */
  dataAttributes?: Record<`data-${string}`, string>;
  /** Extra classes on the card, e.g. the app's paint-containment class. */
  className?: string;
  /** Offline and not on this device (OFFL-PLAY-03): the poster and title are greyed and the card does not open. */
  unavailable?: boolean;
};

/** One title: poster with a watched tick or a progress line, then its title and meta (UX-LIB-02). */
export function BadgerPosterCard({ title, meta, poster, watched = false, progressPct = 0, onOpen, overlay, watchedLabel, testId = "poster-card", dataAttributes, className, unavailable = false }: PosterCardProps) {
  const showProgress = !watched && progressPct > 0 && progressPct < 100;
  return (
    <li className={cn("group relative min-w-0", className)} data-testid={testId} data-unavailable={unavailable || undefined} {...dataAttributes}>
      <button type="button" className={cn("block w-full min-w-0 text-left focus-visible:outline-none", unavailable && cn("cursor-default", UNAVAILABLE_CLASS))} onClick={onOpen} disabled={unavailable} aria-label={title}>
        <span className="relative block aspect-[2/3] overflow-hidden rounded-lg bg-muted shadow-[0_12px_28px_rgba(0,0,0,0.4)] ring-primary transition group-focus-within:ring-2 group-hover:brightness-110">
          {poster}
          {watched ? (
            <span className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_4px_12px_rgba(0,0,0,0.4)]" data-testid={`${testId}-done`} title={watchedLabel}>
              <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
            </span>
          ) : null}
          {showProgress ? <ProgressLine pct={progressPct} className="absolute inset-x-2 bottom-2" track="bg-white/30" /> : null}
        </span>
        <span className="mt-2.5 block truncate text-sm font-semibold text-foreground">{title}</span>
        {meta ? <span className="mt-0.5 block truncate text-[12.5px] text-muted-foreground">{meta}</span> : null}
      </button>
      {overlay}
    </li>
  );
}

type SegmentOption<T extends string> = { id: T; label: string; icon?: ReactNode; testId?: string };

/** The small Movies / TV shows / Playlists switch at the start of the library row (UX-LIB-01). */
export function BadgerSegmented<T extends string>({ options, value, onChange, ariaLabel, testId = "library-toggle" }: { options: SegmentOption<T>[]; value: T; onChange: (id: T) => void; ariaLabel: string; testId?: string }) {
  return (
    <div className="flex gap-1 rounded-[11px] border border-[hsl(var(--border)/0.5)] bg-[hsl(var(--card)/0.8)] p-[3px]" role="tablist" aria-label={ariaLabel} data-testid={testId}>
      {options.map((option) => {
        const on = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={on}
            className={cn(
              "flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3.5 text-[13px] font-bold transition",
              on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => onChange(option.id)}
            data-testid={option.testId}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** The library's search box: 320 × 38 with a magnifier. */
export function BadgerSearchField({ value, onChange, placeholder, testId = "library-search" }: { value: string; onChange: (value: string) => void; placeholder: string; testId?: string }) {
  return (
    <label className="flex h-[38px] w-[320px] items-center gap-2.5 rounded-[10px] border border-border bg-[hsl(var(--background)/0.6)] px-3 text-muted-foreground focus-within:border-primary focus-within:shadow-[0_0_0_3px_hsl(var(--primary)/0.2)]">
      <Search className="h-4 w-4 flex-none" aria-hidden />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        data-testid={testId}
      />
    </label>
  );
}

/** The one slim row above the library grid: toggle, search, then sort / filters / view pushed right (UX-LIB-01). */
export function BadgerLibraryRow({ toggle, search, trailing, testId = "library-row" }: { toggle: ReactNode; search: ReactNode; trailing?: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid={testId}>
      {toggle}
      {search}
      <div className="ml-auto flex items-center gap-2">{trailing}</div>
    </div>
  );
}

/** The row's 38px select button (Sort, Genres, Actors); filled in the accent while a filter is on (UX-LIB-01). */
export function BadgerSelectButton({ label, icon, count = 0, active = false, disabled = false, onClick, testId }: { label: string; icon?: ReactNode; count?: number; active?: boolean; disabled?: boolean; onClick: () => void; testId?: string }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-[38px] items-center gap-2 whitespace-nowrap rounded-[10px] border px-3.5 text-sm font-semibold transition disabled:pointer-events-none disabled:opacity-50 [&_svg]:h-4 [&_svg]:w-4",
        active ? "border-primary bg-primary text-primary-foreground hover:bg-primary/90" : "border-border bg-secondary/50 text-foreground hover:border-primary/60 hover:bg-secondary",
      )}
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
    >
      {icon}
      {label}
      {count ? ` · ${count}` : ""}
    </button>
  );
}

/** A 36px top-bar icon button (Search, Add media, notifications, settings). */
export function BadgerIconButton({ label, icon, onClick, testId, active = false }: { label: string; icon: ReactNode; onClick: () => void; testId?: string; active?: boolean }) {
  return (
    <button
      type="button"
      className={cn("grid h-9 w-9 place-items-center rounded-[10px] text-[var(--chrome-text,hsl(var(--muted-foreground)))] transition hover:bg-white/5 hover:text-white", active && "text-primary")}
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
    >
      {icon}
    </button>
  );
}

/** Ready-made icons for the top bar, so both apps draw the same ones. */
export const badgerTopBarIcons = {
  search: <Search className="h-[18px] w-[18px]" aria-hidden />,
  add: <Plus className="h-5 w-5" aria-hidden />,
  settings: <Settings className="h-[18px] w-[18px]" aria-hidden />,
  home: <House className="h-4 w-4" aria-hidden />,
  library: <Library className="h-4 w-4" aria-hidden />,
  playlists: <ListMusic className="h-4 w-4" aria-hidden />,
};

/** The library row's icons (UX-LIB-01): the Movies / Series toggle, the Sort / Genres / Actors menus and the view switch. */
export const badgerLibraryIcons = {
  movies: <Film className="h-3.5 w-3.5" aria-hidden />,
  series: <Tv className="h-3.5 w-3.5" aria-hidden />,
  sort: <SortAsc aria-hidden />,
  genres: <Filter aria-hidden />,
  actors: <User aria-hidden />,
  posters: <LayoutGrid aria-hidden />,
  compact: <List aria-hidden />,
  details: <Rows3 aria-hidden />,
};

export * from "./PlayerChrome";
