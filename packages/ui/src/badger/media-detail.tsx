/**
 * The Badger film / show detail page shared by the desktop app and the web player (LIB-DETAIL-01..03, REL-FAM-01):
 * the title's backdrop dissolving into the sky, back link, version chips, big title, one amber Play and outlined
 * secondary actions, then tabs.
 * Each app fills the slots with its own data and actions; the layout, tab set and look live here once.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Play } from "lucide-react";
import type { GenreCategory } from "@space/shared";
import { localizedGenreName } from "@space/shared/genreNames";
import { BackButton } from "../button";
import { easedMask } from "../eased-mask";
import { cn } from "../utils";
import { genreIcon } from "./genre-icons";

export * from "./media-detail-seasons";

export type MediaDetailTab = "seasons" | "about" | "versions" | "subtitles" | "jobs";

/**
 * The tabs of a detail page, in order. `seasons`: a show with its seasons view (desktop). `jobs`: the app can add
 * media, so it has processing jobs to show; the web player cannot ingest, so it has no Jobs tab (LIB-DETAIL-01).
 * A show manages versions and subtitles per episode (in its seasons view), so those tabs belong to films.
 */
export const mediaDetailTabs = ({ seasons, jobs }: { seasons: boolean; jobs: boolean }): MediaDetailTab[] => [
  ...(seasons ? (["seasons", "about"] as const) : (["about", "versions", "subtitles"] as const)),
  ...(jobs ? (["jobs"] as const) : []),
];

/** Class names of the two action kinds: the one amber Play, and the outlined secondary actions. */
export const mediaDetailPlayClass =
  "h-[46px] rounded-full bg-primary px-6 text-[15px] font-bold text-primary-foreground shadow-[0_8px_24px_hsl(var(--primary)/0.25)] hover:bg-primary/90";
export const mediaDetailSecondaryClass =
  "h-[46px] rounded-full border border-border bg-secondary/50 px-[18px] text-sm font-bold text-foreground hover:bg-secondary";
/** The filled triangle the approved design draws inside the amber Play button. */
export const mediaDetailPlayIcon = <Play className="h-4 w-4 fill-current" aria-hidden="true" />;

/**
 * The backdrop's two fades (LIB-DETAIL-03): from nothing at its left edge to full over 70% of its width, and from
 * full down to nothing over its lower 70%. The two masks multiply, so the picture has no edge anywhere.
 */
const BACKDROP_MASK = `${easedMask("to right", 0, 70)}, ${easedMask("to bottom", 30, 100, true)}`;
const backdropMaskStyle = {
  maskImage: BACKDROP_MASK,
  WebkitMaskImage: BACKDROP_MASK,
  maskComposite: "intersect",
  WebkitMaskComposite: "source-in",
} as const;

export type MediaDetailVersionChip = { id: string; label: string };

type MediaDetailPageProps = {
  /** The poster image (an <img>), drawn as the cover on the left. */
  poster: ReactNode;
  /** The title's backdrop image (an <img>), drawn soft behind the page; absent = the plain sky, never the poster. */
  backdrop?: ReactNode;
  backLabel: string;
  onBack: () => void;
  /** "Movie" / "Show". */
  kindLabel: string;
  versions: readonly MediaDetailVersionChip[];
  /** The version Play starts on (`pickPlayVersion`), marked on its chip. */
  playVersionId?: string | null;
  playVersionHint?: string;
  /** More chips after the versions ("Watched", "Saved offline"). */
  extraChips?: ReactNode;
  title: ReactNode;
  /** Under the title: original title. */
  subtitle?: ReactNode;
  /** "1927 · 2h 33m": year, runtime; never a rating (META-SRC-05). */
  meta: ReactNode;
  /** Just under the meta line: the title's genres as icon pills (`MediaDetailGenres`). */
  genres?: ReactNode;
  actions: ReactNode;
  children?: ReactNode;
  className?: string;
  testId?: string;
};

export const MediaDetailPage = ({
  poster,
  backdrop,
  backLabel,
  onBack,
  kindLabel,
  versions,
  playVersionId,
  playVersionHint,
  extraChips,
  title,
  subtitle,
  meta,
  genres,
  actions,
  children,
  className,
  testId = "media-detail-page",
}: MediaDetailPageProps) => (
  <div className={cn("relative isolate min-h-full text-foreground", className)} data-testid={testId}>
    {backdrop ? (
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden" data-testid="media-detail-backdrop">
        <div
          className="absolute right-0 top-0 aspect-video w-[72%] max-w-[1280px] opacity-55 saturate-[1.1] [&_img]:h-full [&_img]:w-full [&_img]:object-cover"
          style={backdropMaskStyle}
        >
          {backdrop}
        </div>
      </div>
    ) : null}
    <div className="px-10 pb-16 pt-[22px]">
      <BackButton label={backLabel} onClick={onBack} testId="media-detail-back" />
      <div className="mt-[22px] flex items-start gap-9">
        <div className="w-[230px] flex-none">
          <div className="aspect-[2/3] overflow-hidden rounded-[4px] bg-muted shadow-[0_30px_70px_rgba(0,0,0,0.6)] [&_img]:h-full [&_img]:w-full [&_img]:object-cover">
            {poster}
          </div>
        </div>
        <div className="min-w-0 max-w-[760px] flex-1">
          <div className="flex flex-wrap gap-2" data-testid="media-detail-chips">
            <MediaDetailChip tone="primary">{kindLabel}</MediaDetailChip>
            {versions.map((version) => (
              <MediaDetailChip
                key={version.id}
                data-version-chip={version.label}
                data-plays={version.id === playVersionId ? "true" : undefined}
                title={version.id === playVersionId ? playVersionHint : undefined}
              >
                {version.label}
              </MediaDetailChip>
            ))}
            {extraChips}
          </div>
          <h1 className="mt-3 text-[58px] font-bold leading-none tracking-tight">{title}</h1>
          {subtitle ? <div className="mt-2 text-sm text-muted-foreground">{subtitle}</div> : null}
          <div className="mt-3 text-[15.5px] text-muted-foreground">{meta}</div>
          {genres}
          <div className="mt-6 flex flex-wrap items-center gap-2.5">{actions}</div>
          {children}
        </div>
      </div>
    </div>
  </div>
);

type ChipProps = { tone?: "primary" | "plain"; children: ReactNode; title?: string } & Record<`data-${string}`, string | undefined>;

export const MediaDetailChip = ({ tone = "plain", children, title, ...data }: ChipProps) => (
  <span
    {...data}
    title={title}
    className={cn(
      "inline-flex h-[18px] items-center rounded-md px-[7px] text-[10px] font-extrabold uppercase tracking-[0.06em]",
      tone === "primary" ? "bg-primary/15 text-primary" : "bg-secondary text-foreground/85",
    )}
  >
    {children}
  </span>
);

/**
 * The title's genres as pills, each with its icon (LIB-DETAIL-04), under the header's meta line. A genre id with no
 * name (one the catalog no longer lists) is left out rather than shown as an unnamed pill.
 */
export const MediaDetailGenres = ({ category, ids, language }: { category: GenreCategory; ids: readonly number[]; language: string }) => {
  const genres = ids.flatMap((id) => {
    const name = localizedGenreName(category, id, language);
    return name ? [{ id, name, Icon: genreIcon(category, id) }] : [];
  });
  if (genres.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs" data-testid="media-detail-genres">
      {genres.map(({ id, name, Icon }) => (
        <span key={id} className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-muted-foreground">
          <Icon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          <span>{name}</span>
        </span>
      ))}
    </div>
  );
};

type TabsProps<T extends string> = {
  tabs: readonly { id: T; label: string; icon?: ReactNode }[];
  active: T;
  onChange: (tab: T) => void;
  label: string;
};

export const MediaDetailTabs = <T extends string>({ tabs, active, onChange, label }: TabsProps<T>) => (
  <div role="tablist" aria-label={label} className="mt-[30px] flex gap-7 border-b border-border/60" data-testid="media-detail-tabs">
    {tabs.map((tab) => (
      <button
        key={tab.id}
        type="button"
        role="tab"
        aria-selected={tab.id === active}
        data-tab={tab.id}
        onClick={() => onChange(tab.id)}
        className={cn(
          "inline-flex items-center gap-1.5 pb-3 text-sm font-bold transition",
          tab.id === active ? "text-foreground shadow-[inset_0_-2px_hsl(var(--primary))]" : "text-muted-foreground hover:text-foreground",
        )}
      >
        {tab.icon}
        {tab.label}
      </button>
    ))}
  </div>
);

export type MediaDetailCastMember = { id: string; name: string; role: string | null; avatar?: ReactNode };

/** Initials for a cast member without a photo ("Brigitte Helm" → "BH"). */
export const castInitials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

/** Cast card width and the gap between cards, in CSS pixels (LIB-CAST-02). */
const CAST_CARD_PX = 120;
const CAST_GAP_PX = 16;
/** Lines of cards shown before "Show all cast" (LIB-CAST-02). */
export const CAST_COLLAPSED_LINES = 2;

/** How many whole 120 px cards fit on one line of a grid this wide (the same count CSS `auto-fill` lays out). */
export const castColumns = (width: number): number => Math.max(1, Math.floor((width + CAST_GAP_PX) / (CAST_CARD_PX + CAST_GAP_PX)));

/**
 * LIB-CAST-02: the cast as portrait photo cards (2:3, poster corners), name and role under each, wrapping onto as many
 * lines as the width needs so no card is ever cut. The first two lines show; a longer cast gets "Show all cast (N)",
 * which expands the list in place, and "Show less" folds it back.
 */
export const MediaDetailCast = ({
  heading,
  cast,
  unknownRole,
  empty,
  showAll,
  showLess,
}: {
  heading: string;
  cast: readonly MediaDetailCastMember[];
  unknownRole: string;
  empty: string;
  /** Label of the expand button, with the full count ("Show all cast (24)"). */
  showAll: string;
  showLess: string;
}) => {
  const gridRef = useRef<HTMLDivElement>(null);
  // Before the first measure (and in server renders) assume six cards per line, the desktop dialog's usual width.
  const [columns, setColumns] = useState(6);
  const [expanded, setExpanded] = useState(false);
  const hasCast = cast.length > 0;
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => setColumns(castColumns(grid.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [hasCast]);
  const limit = columns * CAST_COLLAPSED_LINES;
  const overflows = cast.length > limit;
  const shown = expanded || !overflows ? cast : cast.slice(0, limit);
  return (
    <section className="mt-5" data-testid="media-detail-cast">
      <div className="text-[11px] font-black uppercase tracking-[0.14em] text-muted-foreground">{heading}</div>
      {!hasCast ? (
        <p className="mt-3 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <>
          <div
            ref={gridRef}
            className="mt-3 grid grid-cols-[repeat(auto-fill,120px)] gap-x-4 gap-y-5"
            data-testid="media-detail-cast-grid"
            data-columns={columns}
          >
            {shown.map((member) => {
              const role = member.role || unknownRole;
              return (
                <div key={member.id} className="w-[120px] min-w-0" data-cast-card={member.name}>
                  <div className="grid aspect-[2/3] w-full place-items-center overflow-hidden rounded-[4px] border border-border/60 bg-[linear-gradient(140deg,hsl(var(--secondary)),hsl(var(--card)))] text-[28px] font-bold text-muted-foreground [&_img]:h-full [&_img]:w-full [&_img]:object-cover">
                    {member.avatar ?? castInitials(member.name)}
                  </div>
                  <div className="mt-2 truncate text-sm font-semibold" title={member.name}>
                    {member.name}
                  </div>
                  <div className="truncate text-[12.5px] text-muted-foreground" title={role}>
                    {role}
                  </div>
                </div>
              );
            })}
          </div>
          {overflows && (
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
              className="mt-4 rounded-full border border-border/70 px-4 py-1.5 text-sm font-semibold text-foreground transition hover:border-foreground/60"
              data-testid="media-detail-cast-toggle"
            >
              {expanded ? showLess : showAll}
            </button>
          )}
        </>
      )}
    </section>
  );
};

/** LIB-CREW-01: the director and writers, one line per group, shown above the cast; nothing when there are none. */
export const MediaDetailCrew = ({
  heading,
  groups,
}: {
  heading: string;
  groups: ReadonlyArray<{ label: string; names: readonly string[] }>;
}) =>
  groups.some((group) => group.names.length > 0) ? (
    <section className="mt-5" data-testid="media-detail-crew">
      <div className="text-[11px] font-black uppercase tracking-[0.14em] text-muted-foreground">{heading}</div>
      {groups.map((group) =>
        group.names.length > 0 ? (
          <p key={group.label} className="mt-2 text-sm text-muted-foreground">
            <span className="font-semibold text-foreground">{group.label}</span> {group.names.join(", ")}
          </p>
        ) : null
      )}
    </section>
  ) : null;
