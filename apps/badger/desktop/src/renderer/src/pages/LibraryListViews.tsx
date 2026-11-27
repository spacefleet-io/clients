import { formatRating } from "@/lib/localeFormat";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { BadgerLibraryList } from "@space/ui/badger";
import MediaImage from "@/components/MediaImage";
import OfflineBadge from "@/components/OfflineBadge";

export type LibraryListRowModel = {
  id: string;
  title: string;
  year: string | null;
  posterPath: string | null;
  rating: number | null;
  overview: string | null;
  /** Localised genre names, already resolved by the caller. */
  genres: string[];
  seasonCount: number | null;
  runtimeMinutes: number | null;
  /** Watched share, 0-100. */
  progressPct: number;
  disabled: boolean;
  /** Offline and not on this computer (OFFL-PLAY-03): greyed, does not open or play. */
  unavailable?: boolean;
  offlineFull: boolean;
  /** Set while the title is still being imported: the row is read-only and shows this status. */
  ghostStatus: ReactNode | null;
  /** Set while the title is processing: progress 0-100. */
  processing: { label: string; progress: number } | null;
};

type LibraryListRowsProps = {
  rows: LibraryListRowModel[];
  view: "compact" | "details";
  pendingPlayId: string | null;
  playPending: boolean;
  onOpen: (mediaId: string) => void;
  onPlay: (mediaId: string) => void;
};

const formatRuntime = (
  t: (key: string, options?: Record<string, unknown>) => string,
  minutes: number,
): string => {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0
    ? t("library.row.runtimeHours", { hours, minutes: rest })
    : t("library.row.runtimeMinutes", { minutes: rest });
};

export default function LibraryListRows({
  rows,
  view,
  pendingPlayId,
  playPending,
  onOpen,
  onPlay,
}: LibraryListRowsProps) {
  const { t } = useTranslation();
  return (
    <BadgerLibraryList
      view={view}
      pendingPlayId={pendingPlayId}
      playPending={playPending}
      onOpen={onOpen}
      onPlay={onPlay}
      rows={rows.map((row) => ({
        id: row.id,
        title: row.title,
        year: row.year,
        poster: <MediaImage path={row.posterPath} alt={row.title} className="h-full w-full object-cover" />,
        posterBadge: row.offlineFull ? <OfflineBadge state="full" size="sm" inline /> : undefined,
        meta: [
          row.year,
          row.seasonCount ? t("library.row.seasons", { count: row.seasonCount }) : null,
          row.runtimeMinutes ? formatRuntime(t, row.runtimeMinutes) : null,
        ].filter((entry): entry is string => Boolean(entry)),
        ratingText: row.rating ? formatRating(row.rating) : null,
        genres: row.genres,
        overview: row.overview?.trim() ? row.overview : t("library.row.noOverview"),
        progressPct: row.progressPct,
        disabled: row.disabled,
        unavailable: row.unavailable,
        ghostStatus: row.ghostStatus,
        processing: row.processing,
        playLabel: t("library.row.play", { title: row.title }),
      }))}
    />
  );
}
