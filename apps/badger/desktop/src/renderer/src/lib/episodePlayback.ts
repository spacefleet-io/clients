import type { MediaDetails } from "@/lib/libraryDb";

type MediaEpisode = MediaDetails["episodes"][number];

export const formatEpisodeCode = (seasonNumber: number, episodeNumber: number) =>
  `S${seasonNumber}E${String(episodeNumber).padStart(2, "0")}`;

export const getEpisodePlaybackLabel = (episode: MediaEpisode | null | undefined) => {
  if (!episode) return null;
  const code = formatEpisodeCode(episode.seasonNumber, episode.episodeNumber);
  return episode.name ? `${code} - ${episode.name}` : code;
};

/**
 * Pick the episode a single "Play" click should auto-resume into, mirroring the
 * one-click behaviour of the poster Play button. Order of preference:
 *   1. The most-recently-updated in-progress episode (0 < progress < 95%).
 *   2. The first episode (season/episode order) with no meaningful progress.
 *   3. The first episode that has a file, as a final fallback.
 * Returns null for movies (no episode) or a TV show with no file-backed episodes.
 *
 * Pure by construction: the caller supplies `getResumeRaw(episodeId)` which
 * returns the raw stored resume JSON string (or undefined) for an episode — the
 * storage-key shape (`episode_resume_v1:<id>`) stays in the caller, so this
 * stays trivially unit-testable. Extracted verbatim from the previous inline
 * Dashboard logic; keep behaviourally identical (it backs the same Play flow).
 */
export const pickAutoplayEpisodeId = (
  media: MediaDetails,
  getResumeRaw: (episodeId: string) => string | undefined,
): string | null => {
  if (media.type !== "tv") return null;
  const playable = media.episodes
    .filter((episode) =>
      media.files.some(
        (file) => file.season === episode.seasonNumber && file.episode === episode.episodeNumber,
      ),
    )
    .slice()
    .sort(
      (left, right) =>
        left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber,
    );
  const inProgress = playable
    .map((episode) => {
      const raw = getResumeRaw(episode.id);
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as { progressPct?: number; updatedAt?: string };
        const pct = Number(parsed.progressPct);
        if (!Number.isFinite(pct) || pct <= 0 || pct >= 95) return null;
        const updatedAtMs = Number.isFinite(Date.parse(parsed.updatedAt ?? ""))
          ? Date.parse(parsed.updatedAt ?? "")
          : 0;
        return { id: episode.id, updatedAtMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { id: string; updatedAtMs: number } => Boolean(entry))
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
  if (inProgress.length > 0) {
    return inProgress[0]!.id;
  }
  const firstUnwatched = playable.find((episode) => {
    const raw = getResumeRaw(episode.id);
    if (!raw) return true;
    try {
      const parsed = JSON.parse(raw) as { progressPct?: number };
      const pct = Number(parsed.progressPct);
      return !Number.isFinite(pct) || pct <= 0;
    } catch {
      return true;
    }
  });
  return firstUnwatched?.id ?? playable[0]?.id ?? null;
};
