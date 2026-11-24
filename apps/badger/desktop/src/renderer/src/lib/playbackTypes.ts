import type { MediaDetails, ProgressTiming } from "@/lib/libraryDb";
import type { QualityPreset } from "@/lib/config";
import type { TrackPrefs, TrackPrefsPatch } from "@space/shared/trackPrefs";
import type { SkipEditDeps } from "@/lib/mpvSkipEdit";

/**
 * The library actions the player's skip editing uses (PLAY-SKIP-03/05); `onChanged` refreshes the playing media
 * once times were saved, so the next envelope sends them to sf.lua.
 */
export type SkipEditLibrary = Pick<SkipEditDeps, "listSkipAnalysis" | "upsertSkipAnalysis" | "replaceSkipMarkers"> & {
  onChanged: () => Promise<void>;
};

/** The library's add-a-subtitle-track action (`useLibraryActions().addSubtitleTrack`). */
export type AddSubtitleTrack = (
  mediaId: string,
  episodeId: string | null,
  language: string,
  label: string,
  objectKey: string,
  format?: string | null,
  source?: string | null
) => Promise<void>;

export type SubtitleOption = {
  id: string;
  label: string;
  language: string;
  isDefault?: boolean;
  objectKey?: string | null;
  format?: string | null;
};

export type SubtitleImageCue = {
  startMs: number;
  endMs: number;
  imageBase64: string;
};

export type AudioOption = {
  id: string;
  label: string;
  language: string;
  isDefault?: boolean;
  codec?: string | null;
  codecString?: string | null;
  initKey?: string | null;
  initSize?: number | null;
  durationSeconds?: number | null;
  totalSize?: number | null;
  chunks?: Array<{ key: string; sizeBytes: number | null; startSeconds: number | null }>;
};

export type UsePlaybackEngineParams = {
  open: boolean;
  media: MediaDetails;
  /**
   * The playing media's latest formats in the library (MPV-PREV-04). `media` is the snapshot taken at launch; the
   * runtime may record the preview sheets while the video plays, so the preview record is read from here.
   */
  libraryFormats?: MediaDetails["formats"] | null;
  episodeId?: string | null;
  /** Centre previous-episode button target in the mpv overlay (PLAY-OVL-03). */
  previousEpisode?: { id: string; label: string } | null;
  nextEpisode?: { id: string; label: string } | null;
  token: string | null;
  blockAutoPlay: boolean;
  deferPlayback: boolean;
  playbackQuality: QualityPreset;
  forcePlaybackQuality: boolean;
  autoplayNextEpisode: boolean;
  autoSkipIntro: boolean;
  autoSkipCredits: boolean;
  setMediaFormatChunks: (
    formatId: string,
    chunks: Array<{ key: string; sizeBytes?: number | null; startSeconds?: number | null }> | string[]
  ) => Promise<void>;
  // Phase 2: optional 4th-arg timing payload so the persisted progress
  // includes absolute positionSeconds + durationSeconds (used by the
  // credits-aware completion check). Pre-Phase-2 callers still work — the
  // libraryContext setProgress treats `timing` as optional.
  setProgress: (
    mediaId: string,
    pct: number,
    episodeId?: string | null,
    timing?: ProgressTiming | null
  ) => Promise<void>;
  /** Remembered audio/subtitle choice of this movie / show (PLAY-TRACK-04); null when none. */
  trackPrefs: TrackPrefs | null;
  setTrackPrefs: (mediaId: string, patch: TrackPrefsPatch) => Promise<void>;
  /** Stores a subtitle track (library action); enables the mpv menu's "Get more subtitles…" row (PLAY-SUBGET-02). */
  addSubtitleTrack?: AddSubtitleTrack;
  /**
   * Deletes a subtitle track, resolving once the library has (library action `removeSubtitleTrackNow`); with
   * addSubtitleTrack, enables "Try another version" (PLAY-SUBGET-07).
   */
  removeSubtitleTrack?: (trackId: string) => Promise<void>;
  /** The stored files the library names for a media: the replaced subtitle's file is deleted once it is not among them. */
  getMediaObjectKeys?: (mediaId: string) => Promise<string[]>;
  /** Absent: the host cannot store skip times, and the player's skip editing does nothing (PLAY-SKIP-05). */
  skipEditLibrary?: SkipEditLibrary;
  t: (key: string, options?: Record<string, unknown>) => string;
};
