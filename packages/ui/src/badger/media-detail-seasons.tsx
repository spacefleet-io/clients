/**
 * A show's Seasons tab, shared by the desktop detail page and the web player (LIB-DETAIL-01, REL-FAM-01): the season
 * cards, the "Seasons › Season N" crumb, and one row per episode with its picture, title, chips, synopsis, progress
 * and actions. Each app fills the slots (its own artwork loader, its own Play and extra actions).
 */
import type { KeyboardEvent, ReactNode } from "react";
import { CheckCircle2, ChevronRight } from "lucide-react";
import { UNAVAILABLE_CLASS } from "../unavailable";
import { cn } from "../utils";

/** The seasons heading, then the season cards three to a row, or the empty line. */
export const MediaDetailSeasonList = ({ heading, empty, children }: { heading: string; empty: string | null; children?: ReactNode }) => (
  <div className="space-y-4" data-testid="media-detail-seasons">
    <div className="text-sm font-semibold">{heading}</div>
    {empty !== null ? (
      <div className="text-sm text-muted-foreground">{empty}</div>
    ) : (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    )}
  </div>
);

type SeasonCardProps = {
  seasonNumber: number;
  poster: ReactNode;
  name: string;
  /** "8 episodes". */
  episodeCount: string;
  /** "Available" / "Missing files". */
  status: string;
  /** A season without any stored episode is greyed. */
  available: boolean;
  onSelect: () => void;
  /** Overlays over the card (desktop: the offline button and stamp). */
  children?: ReactNode;
};

export const MediaDetailSeasonCard = ({ seasonNumber, poster, name, episodeCount, status, available, onSelect, children }: SeasonCardProps) => (
  <div className="group relative" data-season={seasonNumber}>
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 rounded-xl border border-border p-3 text-left transition hover:border-primary/40 hover:bg-muted/30",
        !available && UNAVAILABLE_CLASS,
      )}
    >
      <div className="h-20 w-14 shrink-0 overflow-hidden rounded-lg bg-muted">{poster}</div>
      {/* The status sits under the episode count, not in a third column: a long status ("Fichiers manquants") beside
          the name squeezed "Saison 1" onto two lines. */}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold" title={name}>{name}</div>
        <div className="text-xs text-muted-foreground">{episodeCount}</div>
        <div className="text-xs text-muted-foreground" data-testid="media-detail-season-status">{status}</div>
      </div>
    </button>
    {children}
  </div>
);

/** "Seasons › Season 2": the first part goes back to the season cards. */
export const MediaDetailSeasonCrumb = ({ seasons, current, onSeasons }: { seasons: string; current: string; onSeasons: () => void }) => (
  <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="media-detail-season-crumb">
    <button type="button" className="rounded-full border border-border px-2 py-1 hover:border-primary/40" onClick={onSeasons}>
      {seasons}
    </button>
    <ChevronRight className="h-3 w-3" />
    <span>{current}</span>
  </div>
);

/** The episodes of one season under the crumb, or the empty line. */
export const MediaDetailEpisodeList = ({ crumb, empty, children }: { crumb: ReactNode; empty: string | null; children?: ReactNode }) => (
  <div className="space-y-3" data-testid="media-detail-episodes">
    {crumb}
    <div className="grid gap-3">{empty !== null ? <div className="text-sm text-muted-foreground">{empty}</div> : children}</div>
  </div>
);

type EpisodeRowProps = {
  episodeId: string;
  thumbnail: ReactNode;
  /** Pinned half off the thumbnail's top-left corner (desktop: "Saved offline"). */
  thumbnailBadge?: ReactNode;
  /** "Episode 3 · The Name". */
  title: string;
  /** After the title (track counts). */
  titleChips?: ReactNode;
  /** Under the title (version chips). */
  chips?: ReactNode;
  overview: string;
  /** Under the synopsis: `MediaDetailEpisodeProgress` or a placeholder. */
  progress?: ReactNode;
  /** Right side: Play and the other actions. */
  actions?: ReactNode;
  /** An episode without a stored file is greyed. */
  available: boolean;
  selected?: boolean;
  onSelect?: () => void;
};

export const MediaDetailEpisodeRow = ({
  episodeId,
  thumbnail,
  thumbnailBadge,
  title,
  titleChips,
  chips,
  overview,
  progress,
  actions,
  available,
  selected = false,
  onSelect,
}: EpisodeRowProps) => (
  <div
    data-episode={episodeId}
    className={cn(
      "rounded-xl border border-border p-4 transition",
      available ? "bg-muted/10" : cn("bg-muted/30", UNAVAILABLE_CLASS),
      selected ? "border-primary" : "hover:border-primary/40",
    )}
    onClick={onSelect}
    role={onSelect ? "button" : undefined}
    tabIndex={onSelect ? 0 : undefined}
    onKeyDown={onSelect ? (event: KeyboardEvent) => event.key === "Enter" && onSelect() : undefined}
  >
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 items-start gap-4">
        {/* `relative` (not overflow-hidden) so the corner badge can sit half off the picture. */}
        <div className="relative h-20 w-20 shrink-0">
          <div className="h-full w-full overflow-hidden rounded-lg bg-muted">{thumbnail}</div>
          {thumbnailBadge}
        </div>
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            <span>{title}</span>
            {titleChips}
          </div>
          {chips}
          <div className="text-xs text-muted-foreground">{overview}</div>
          {progress}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2 sm:justify-end">{actions}</div> : null}
    </div>
  </div>
);

/** An episode's progress: "Watched" with a full bar, or "42% watched" with the bar filled that far. */
export const MediaDetailEpisodeProgress = ({ watched, label, pct }: { watched: boolean; label: string; pct: number }) =>
  watched ? (
    <div className="mt-2 space-y-1" data-testid="media-detail-episode-progress" data-state="watched">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-primary">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
        <span>{label}</span>
      </div>
      <div className="h-1.5 w-36 rounded-full bg-primary" aria-hidden="true" />
    </div>
  ) : (
    <div className="mt-2 space-y-1" data-testid="media-detail-episode-progress" data-state="in-progress">
      <div className="text-[11px] font-medium text-primary">{label}</div>
      <div className="h-1.5 w-36 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
