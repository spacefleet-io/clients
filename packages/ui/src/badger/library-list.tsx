/**
 * The library's compact and details lists (the view switch's second and third choice, UX-LIB-01), shared by the Badger
 * desktop app and the web player (REL-FAM-02). Texts arrive translated and posters as elements, like the poster grid.
 */
import type { ReactNode } from "react";
import { Loader2, PlayCircle } from "lucide-react";
import { Button } from "../button";
import { RenderBoundary } from "../render-boundary";
import { UNAVAILABLE_CLASS } from "../unavailable";
import { cn } from "../utils";

export type BadgerLibraryListRow = {
  id: string;
  title: string;
  year: string | null;
  poster: ReactNode;
  /** Drawn over the poster's top-left corner (the desktop's offline badge). */
  posterBadge?: ReactNode;
  /** Details line: year, seasons, runtime, already formatted. */
  meta: string[];
  /** Localised genre names. */
  genres: string[];
  /** Details view's summary; null draws none. */
  overview: string | null;
  /** Watched share, 0-100. */
  progressPct: number;
  disabled: boolean;
  /** Offline and not on this device (OFFL-PLAY-03): greyed, and the row neither opens nor plays. */
  unavailable?: boolean;
  /** Set while the title is still being imported: the row is read-only and shows this status. */
  ghostStatus: ReactNode | null;
  /** Set while the title is processing: progress 0-100. */
  processing: { label: string; progress: number } | null;
  /** The row's Play button label ("Play Metropolis"). */
  playLabel: string;
};

export function BadgerLibraryList({
  rows,
  view,
  pendingPlayId = null,
  playPending = false,
  onOpen,
  onPlay,
}: {
  rows: BadgerLibraryListRow[];
  view: "compact" | "details";
  pendingPlayId?: string | null;
  playPending?: boolean;
  onOpen: (id: string) => void;
  /** Without it the rows have no Play button: opening the title is the way to play. */
  onPlay?: (id: string) => void;
}) {
  const compact = view === "compact";
  return (
    <ul className="space-y-2" data-testid={`library-list-${view}`}>
      {rows.map((row) => {
        const isGhost = row.ghostStatus !== null;
        const inert = isGhost || Boolean(row.unavailable);
        const playing = pendingPlayId === row.id && playPending;
        return (
          <li key={row.id}>
            {/* UX-CRASH-01: a row that throws shows a placeholder in its place; the other rows stay. */}
            <RenderBoundary name={`library-row:${row.id}`} variant="item">
            <div
              data-testid={`library-row-${row.id}`}
              data-unavailable={row.unavailable || undefined}
              role={inert ? undefined : "button"}
              tabIndex={inert ? undefined : 0}
              aria-disabled={row.unavailable || undefined}
              className={cn(
                "space-tile group relative flex items-center gap-4 rounded-xl text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[#ffaa54]/40",
                compact ? "px-3 py-2" : "p-3",
                isGhost ? "opacity-70" : row.unavailable ? "cursor-default" : "cursor-pointer",
                row.unavailable ? UNAVAILABLE_CLASS : row.disabled && !isGhost && "opacity-60 grayscale",
              )}
              onClick={inert ? undefined : () => onOpen(row.id)}
              onKeyDown={
                inert
                  ? undefined
                  : (event) => {
                      // Keys pressed on the Play button inside the row belong to that button.
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onOpen(row.id);
                      }
                    }
              }
            >
              <div className={cn("relative shrink-0 overflow-hidden rounded-md bg-muted", compact ? "h-[54px] w-9" : "h-[150px] w-[100px]")}>
                {row.poster}
                {row.posterBadge ? <div className="pointer-events-none absolute left-1 top-1">{row.posterBadge}</div> : null}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-3">
                  <div className={cn("truncate font-semibold", compact ? "text-sm" : "text-base")}>{row.title}</div>
                  {compact && row.year ? <div className="shrink-0 text-xs text-[#8b949e]">{row.year}</div> : null}
                </div>
                {!compact ? (
                  <>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#8b949e]">
                      {row.meta.map((entry) => (
                        <span key={entry}>{entry}</span>
                      ))}
                    </div>
                    {row.genres.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {row.genres.map((genre) => (
                          <span key={genre} className="rounded-full border border-[#30363d] bg-[#161b22] px-2 py-0.5 text-[11px] text-[#c9d1d9]">
                            {genre}
                          </span>
                        ))}
                      </div>
                    ) : null}
                    {row.overview !== null ? <p className="mt-2 line-clamp-3 text-sm text-[#c9d1d9]">{row.overview}</p> : null}
                    {row.progressPct > 0 && row.progressPct < 100 ? (
                      <div className="mt-3 h-1.5 w-48 overflow-hidden rounded-full bg-white/10">
                        <div className="h-full bg-[#ffaa54]" style={{ width: `${row.progressPct}%` }} />
                      </div>
                    ) : null}
                  </>
                ) : null}
                {row.processing ? (
                  <div className="mt-1 flex items-center gap-3 text-xs text-[#8b949e]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>{row.processing.label}</span>
                    <div className="h-1.5 w-32 overflow-hidden rounded-full bg-white/10">
                      <div className="h-full bg-[#ffaa54]" style={{ width: `${row.processing.progress}%` }} />
                    </div>
                  </div>
                ) : null}
                {isGhost ? (
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-[#8b949e]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {row.ghostStatus}
                  </div>
                ) : null}
              </div>

              {onPlay && !inert && !row.disabled ? (
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  aria-label={row.playLabel}
                  className="shrink-0 border border-[#30363d] bg-[#161b22] text-white hover:border-[#ffaa54]/60"
                  disabled={playing}
                  onClick={(event) => {
                    event.stopPropagation();
                    onPlay(row.id);
                  }}
                >
                  {playing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlayCircle className="h-4 w-4" />}
                </Button>
              ) : null}
            </div>
            </RenderBoundary>
          </li>
        );
      })}
    </ul>
  );
}
