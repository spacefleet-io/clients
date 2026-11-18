import type { AudioTrack, MediaDetails, MediaFormat, SubtitleTrack } from "@/lib/libraryDb";
import { qualityRank } from "@/lib/labJobs";
import { playableEpisodeKeysNow } from "@space/shared/offlineReach";
import { getPlayableEpisodeKeySet } from "@space/shared/playableEpisodes";
import { isEpisodeCompleted } from "@space/shared/playbackResume";

export type EpisodeResumeEntry = {
  progressPct: number;
  updatedAtMs: number;
  // Phase 2: optional absolute position + duration persisted alongside the
  // legacy progressPct so the credits-aware completion check can compare in
  // absolute seconds (not just percent). Old payloads without these fields
  // parse cleanly and degrade to the legacy pct-only rule.
  positionSeconds?: number;
  durationSeconds?: number;
};

// Phase 2: per-episode credits-start (absolute seconds) + episode duration.
// Built from MediaDetails.skipMarkers (skip times served by the metadata service)
// and MediaDetails.files/formats (per-file durationSeconds). Episodes
// without a credits marker are NOT keyed in the map — the consumer falls
// back to the legacy 95 % pct ceiling for those, which is the correct
// graceful-degradation behavior.
export type EpisodeCreditsEntry = {
  creditsStartSeconds: number;
  // Duration here is per-episode (from the episode's formats). The picker
  // doesn't have a runtime mpv duration to lean on, so this is the best
  // source available at dialog-mount time.
  durationSeconds: number;
};

export type MediaFilePresence = {
  seasonHasFiles: Map<number, boolean>;
  episodeHasFile: Set<string>;
};

export const buildMediaFilePresence = (details: MediaDetails | null): MediaFilePresence => {
  if (!details) {
    return { seasonHasFiles: new Map<number, boolean>(), episodeHasFile: new Set<string>() };
  }
  const playableEpisodeKeys = getPlayableEpisodeKeySet(details);
  const seasonHasFiles = new Map<number, boolean>();
  const episodeHasFile = new Set<string>();
  playableEpisodeKeys.forEach((key) => {
    const [seasonRaw, episodeRaw] = key.split(":");
    const season = Number(seasonRaw);
    const episode = Number(episodeRaw);
    if (!Number.isFinite(season) || !Number.isFinite(episode)) return;
    seasonHasFiles.set(season, true);
    episodeHasFile.add(`${season}-${episode}`);
  });
  return { seasonHasFiles, episodeHasFile };
};

/**
 * OFFL-PLAY-03: the episodes (and so the seasons) that can start right now. Online it is `presence` itself; offline,
 * only the episodes with a file also downloaded on this computer (`episodesLocal`, `"season-episode"` keys).
 */
export const playableNowPresence = (
  presence: MediaFilePresence,
  online: boolean,
  episodesLocal: ReadonlySet<string>,
): MediaFilePresence => {
  if (online) return presence;
  const episodeHasFile = new Set(playableEpisodeKeysNow(false, presence.episodeHasFile, episodesLocal));
  const seasonHasFiles = new Map<number, boolean>();
  episodeHasFile.forEach((key) => seasonHasFiles.set(Number(key.split("-")[0]), true));
  return { seasonHasFiles, episodeHasFile };
};

export type EpisodeResumeMap = {
  entries: Map<string, EpisodeResumeEntry>;
  isReady: boolean;
};

export const buildEpisodeResumeMap = (
  details: MediaDetails | null,
  getSharedSetting: (key: string) => { value?: string | null } | null,
  playbackReady: boolean
): EpisodeResumeMap => {
  const entries = new Map<string, EpisodeResumeEntry>();
  if (!playbackReady || !details || details.type !== "tv") {
    return { entries, isReady: playbackReady };
  }
  details.episodes.forEach((episode) => {
    const raw = getSharedSetting(`episode_resume_v1:${episode.id}`)?.value;
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as {
        progressPct?: number;
        updatedAt?: string;
        // Phase 2 additive: read positionSeconds / durationSeconds when
        // present. Older payloads (pre-Phase-2 writes) lack these fields
        // and the entry simply has them undefined — picker / prompt fall
        // back to pct * duration.
        positionSeconds?: number;
        durationSeconds?: number;
      };
      // A play to the true end saves 100 % (mpv keep-open lands time-pos at or past
      // the duration). Keep it: the row then reads Watched and the picker skips it.
      // Only 0 % (never meaningfully started) is dropped. @req PLAY-RESUME-02
      const rawPct = Number(parsed.progressPct);
      if (!Number.isFinite(rawPct) || rawPct <= 0) return;
      const pct = Math.min(100, rawPct);
      const parsedUpdatedAt = Date.parse(parsed.updatedAt ?? "");
      const updatedAtMs = Number.isFinite(parsedUpdatedAt) ? parsedUpdatedAt : 0;
      const entry: EpisodeResumeEntry = { progressPct: pct, updatedAtMs };
      const positionSeconds = Number(parsed.positionSeconds);
      if (Number.isFinite(positionSeconds) && positionSeconds >= 0) {
        entry.positionSeconds = positionSeconds;
      }
      const durationSeconds = Number(parsed.durationSeconds);
      if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
        entry.durationSeconds = durationSeconds;
      }
      entries.set(episode.id, entry);
    } catch {
      // Ignore malformed resume payloads.
    }
  });
  return { entries, isReady: true };
};

// Phase 2: build per-episode credits-start + duration map from MediaDetails.
// - credits-start comes from MediaDetails.skipMarkers (the metadata service);
//   only entries with type === "credits" and a finite startSeconds > 0 are
//   considered.
// - duration is the MAX durationSeconds across the episode's formats
//   (mirrors useMpvPlaybackEngine's fallbackDuration heuristic).
// Episodes lacking either piece are omitted from the map; consumers treat
// "not in map" as "no credits data — use the legacy 95 % rule".
export const buildEpisodeCreditsMap = (
  details: MediaDetails | null
): Map<string, EpisodeCreditsEntry> => {
  const map = new Map<string, EpisodeCreditsEntry>();
  if (!details || details.type !== "tv") return map;
  // Index credits markers by episodeId. Movies have episodeId === null and
  // are explicitly out of scope for the picker, which is TV-only.
  const creditsByEpisode = new Map<string, number>();
  details.skipMarkers.forEach((marker) => {
    if (marker.type !== "credits") return;
    if (!marker.episodeId) return;
    const start = Number(marker.startSeconds);
    if (!Number.isFinite(start) || start <= 0) return;
    const existing = creditsByEpisode.get(marker.episodeId);
    // If multiple credits markers exist for an episode, take the earliest
    // — the one farthest from EOF is the safer "watched past credits"
    // boundary. (In practice the metadata service returns at most one per type.)
    if (existing === undefined || start < existing) {
      creditsByEpisode.set(marker.episodeId, start);
    }
  });
  if (creditsByEpisode.size === 0) return map;
  // Per-episode duration: index files by (season, episode) then look up the
  // formats whose fileId matches; take the MAX of their durationSeconds.
  const fileByEpisodeKey = new Map<string, string[]>();
  details.files.forEach((file) => {
    if (file.season == null || file.episode == null) return;
    const key = `${file.season}-${file.episode}`;
    const list = fileByEpisodeKey.get(key) ?? [];
    list.push(file.id);
    fileByEpisodeKey.set(key, list);
  });
  const durationByFileId = new Map<string, number>();
  details.formats.forEach((format) => {
    const duration = Number(format.durationSeconds);
    if (!Number.isFinite(duration) || duration <= 0) return;
    const existing = durationByFileId.get(format.fileId);
    if (existing === undefined || duration > existing) {
      durationByFileId.set(format.fileId, duration);
    }
  });
  details.episodes.forEach((episode) => {
    const creditsStart = creditsByEpisode.get(episode.id);
    if (creditsStart === undefined) return;
    const fileIds = fileByEpisodeKey.get(`${episode.seasonNumber}-${episode.episodeNumber}`) ?? [];
    let maxDuration = 0;
    fileIds.forEach((fileId) => {
      const d = durationByFileId.get(fileId);
      if (d !== undefined && d > maxDuration) maxDuration = d;
    });
    if (maxDuration <= 0) return;
    map.set(episode.id, { creditsStartSeconds: creditsStart, durationSeconds: maxDuration });
  });
  return map;
};

export const formatEpisodeCode = (seasonNumber: number, episodeNumber: number) =>
  `S${seasonNumber}E${String(episodeNumber).padStart(2, "0")}`;

export const resolveDefaultPlayableEpisodeId = (
  details: MediaDetails | null,
  filePresence: MediaFilePresence,
  episodeResumeById: Map<string, EpisodeResumeEntry>,
  // Phase 2: optional per-episode credits-start lookup. When supplied,
  // an episode is considered "completed" if the watched absolute time is
  // past the credits-start (service-derived). When absent (legacy
  // callers, or markers not yet hydrated), the helper falls back to the
  // flat 95 % rule — same behavior as before Phase 2.
  episodeCreditsById?: Map<string, EpisodeCreditsEntry>
) => {
  if (!details || details.type !== "tv") return null;
  const playable = details.episodes
    .filter((episode) => filePresence.episodeHasFile.has(`${episode.seasonNumber}-${episode.episodeNumber}`))
    .sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
  if (playable.length === 0) return null;
  // Earliest non-completed playable episode wins; recency is intentionally
  // ignored. Completion is credits-aware when markers are available, else
  // 95 % pct fallback — single source of truth in isEpisodeCompleted.
  const firstUnfinished = playable.find(
    (episode) => !isEpisodeResumeCompleted(episodeResumeById.get(episode.id), episodeCreditsById?.get(episode.id))
  );
  return firstUnfinished?.id ?? playable[0]?.id ?? null;
};

/** Whether a saved resume entry counts as watched (credits-aware, else the 95 % rule). No entry = never started. */
export const isEpisodeResumeCompleted = (
  resume: EpisodeResumeEntry | undefined,
  credits: EpisodeCreditsEntry | undefined
) => {
  if (!resume) return false;
  return isEpisodeCompleted({
    progressPct: resume.progressPct,
    positionSeconds: resume.positionSeconds,
    durationSeconds: resume.durationSeconds ?? credits?.durationSeconds ?? null,
    creditsStartSeconds: credits?.creditsStartSeconds ?? null,
  });
};

export const resolveDefaultPlayableEpisodeLabel = (
  details: MediaDetails | null,
  defaultPlayableEpisodeId: string | null
) => {
  if (!details || details.type !== "tv" || !defaultPlayableEpisodeId) return null;
  const episode = details.episodes.find((item) => item.id === defaultPlayableEpisodeId);
  if (!episode) return null;
  return formatEpisodeCode(episode.seasonNumber, episode.episodeNumber);
};

export const collectAvailableMovieQualities = (details: MediaDetails | null): MediaFormat[] => {
  if (!details) return [];
  const movieFileIds = details.files
    .filter((file) => file.season == null && file.episode == null)
    .map((file) => file.id);
  const fileIds = movieFileIds.length > 0 ? new Set(movieFileIds) : new Set(details.files.map((file) => file.id));
  const seen = new Set<string>();
  const formats: MediaFormat[] = [];
  details.formats.forEach((format) => {
    if (!fileIds.has(format.fileId)) return;
    if (seen.has(format.quality)) return;
    seen.add(format.quality);
    formats.push(format);
  });
  return formats.sort((a, b) => qualityRank(a.quality) - qualityRank(b.quality));
};

export const collectEpisodeQualities = (details: MediaDetails | null): Map<string, MediaFormat[]> => {
  const map = new Map<string, MediaFormat[]>();
  if (!details) return map;
  const formatsByFile = new Map<string, MediaFormat[]>();
  details.formats.forEach((format) => {
    const list = formatsByFile.get(format.fileId) ?? [];
    list.push(format);
    formatsByFile.set(format.fileId, list);
  });
  details.files.forEach((file) => {
    if (file.season == null || file.episode == null) return;
    const key = `${file.season}-${file.episode}`;
    const fileFormats = formatsByFile.get(file.id) ?? [];
    const existing = map.get(key) ?? [];
    const seen = new Set(existing.map((f) => f.quality));
    const merged: MediaFormat[] = [...existing];
    fileFormats.forEach((format) => {
      if (seen.has(format.quality)) return;
      seen.add(format.quality);
      merged.push(format);
    });
    map.set(key, merged.sort((a, b) => qualityRank(a.quality) - qualityRank(b.quality)));
  });
  return map;
};

export const countEpisodeTracks = <TTrack extends AudioTrack | SubtitleTrack>(tracks: TTrack[]) => {
  const map = new Map<string, number>();
  tracks.forEach((track) => {
    if (!track.episodeId) return;
    map.set(track.episodeId, (map.get(track.episodeId) ?? 0) + 1);
  });
  return map;
};
