/**
 * Pure helper used by FileIngestionDialog's V2 submission branch.
 *
 * Translates the legacy `LabQueueAction[]` produced by the dialog into the
 * shape consumed by `runtime.jobs.v2`'s `submit_sources` command. The legacy
 * `queue_files` action carries BOTH the real source video AND a synthetic
 * "transcode" placeholder as separate `LabQueueFileInput` entries. The V2
 * pipeline already produces format jobs internally from `desiredFormats`, so
 * forwarding the synthetic transcode placeholder as a second source produced
 * the "4 jobs per movie" bug (1 source + 1 format per source = 4 instead of 2).
 *
 * This helper filters out non-source entries before flatMapping, so V2 only
 * ever sees the actual source files.
 *
 * It also forwards the per-file `audioTrackOverrides` / `subtitleTrackOverrides`
 * that the dialog accumulates (undefined-language picks AND auto-detected
 * corrections) into the V2 submit_sources `audioOverrides` / `subtitleOverrides`
 * fields. Without this hand-off, the runtime never sees the user's language
 * picks and media_audio_tracks ships with `language='und', label='Undefined'`.
 *
 * @bugfix effervescent-teapot Symptom A
 * @bugfix Bug #4 audio language override dropped end-to-end
 * @regression-proof
 */
import type { LabQueueAction } from "@/lib/labJobs";
import type { LabQueueFileInput } from "../../../shared/labQueueShared";
import type {
  BadgerIngestShowSkipCache,
  BadgerIngestSkipMarker,
} from "@space/runtime-contracts/badger/ingest";

export type V2Quality = "144p" | "240p" | "360p" | "480p" | "720p" | "1080p";

export type V2TrackOverride = { index: number; language: string; label: string };

export type V2SubmitSource = {
  filename: string;
  sizeMb: number | null;
  sourceQuality?: string;
  desiredFormats: V2Quality[];
  hints?: { mediaId?: string; season?: number; episode?: number };
  audioOverrides?: V2TrackOverride[];
  subtitleOverrides?: V2TrackOverride[];
  /** Per-episode markers for THIS file's episode (TV only). */
  skipMarkers?: BadgerIngestSkipMarker[];
  /** Full-show cache (TV only, idempotent across source jobs of the same show). */
  showSkipCache?: BadgerIngestShowSkipCache;
};

/**
 * Treat entries with `jobType === "source"` OR a missing/undefined `jobType`
 * (legacy entries) as real sources. Anything explicitly tagged "transcode" or
 * any other non-source value is dropped — V2 derives format jobs from
 * `desiredFormats`, not from extra synthetic entries.
 */
export const isV2SourceEntry = (file: LabQueueFileInput): boolean => {
  const jobType = file.jobType;
  return jobType === undefined || jobType === "source";
};

// Per-file track overrides arrive in the same `{ index, language, label }`
// shape the V2 contract expects (audio-only / subtitle-only index, ISO 639
// language code, free-form label). The renderer's preload-side probe IPC
// builds the per-kind index via `audioStreams.map((stream, index) => ...)`,
// so no conversion is required here. Empty / missing arrays become
// `undefined` so the contract stays minimal on the wire.
const sanitizeOverrides = (
  overrides: ReadonlyArray<{ index: number; language: string; label: string }> | undefined,
): V2TrackOverride[] | undefined => {
  if (!overrides || overrides.length === 0) return undefined;
  return overrides.map((o) => ({
    index: o.index,
    language: o.language,
    label: o.label,
  }));
};

export const translateActionsToV2Sources = (
  actions: LabQueueAction[],
  desiredFormats: V2Quality[],
  options?: {
    showSkipDataByTmdbId?: Map<number, BadgerIngestShowSkipCache>;
  }
): V2SubmitSource[] => {
  return actions
    .filter(
      (a): a is Extract<LabQueueAction, { type: "queue_files" }> =>
        a.type === "queue_files"
    )
    .flatMap((a) => {
      const presetMediaId =
        (a.preset?.media as { id?: string } | undefined)?.id ??
        (
          a.preset?.pendingMedia as { tmdbId?: number } | undefined
        )?.tmdbId?.toString();
      // TV preset: thread season/episode onto the wire so the runtime's
      // commit step can stamp media_files / media_audio_tracks with the
      // correct (season, episode), which in turn allows the renderer to
      // resolve `defaultPlayableEpisodeId` from `getPlayableEpisodeKeySet`.
      // Without this, addAudioTrackWithChunks stores `episodeId = null` and
      // the play button stays disabled forever after ingest succeeds.
      // Contract: badgerIngestSubmitSourceItemSchema accepts both fields as
      // positive integers (packages/runtime-contracts/src/badger/ingest.ts).
      const presetSeason =
        typeof a.preset?.season === "number" && a.preset.season > 0
          ? a.preset.season
          : undefined;
      const presetEpisode =
        typeof a.preset?.episode === "number" && a.preset.episode > 0
          ? a.preset.episode
          : undefined;
      const hints: { mediaId?: string; season?: number; episode?: number } = {};
      if (presetMediaId) hints.mediaId = presetMediaId;
      if (presetSeason !== undefined) hints.season = presetSeason;
      if (presetEpisode !== undefined) hints.episode = presetEpisode;
      const emittedHints = Object.keys(hints).length > 0 ? hints : undefined;
      const presetType =
        (a.preset?.media as { type?: string } | undefined)?.type ??
        (a.preset?.pendingMedia as { type?: string } | undefined)?.type;
      const presetTmdbId =
        (a.preset?.media as { tmdbId?: number | null } | undefined)?.tmdbId ??
        (a.preset?.pendingMedia as { tmdbId?: number | null } | undefined)?.tmdbId ??
        null;
      const showSkipCache =
        presetType === "tv" && typeof presetTmdbId === "number"
          ? options?.showSkipDataByTmdbId?.get(presetTmdbId)
          : undefined;
      return a.files.filter(isV2SourceEntry).map((file) => {
        const isTvSource = presetType === "tv" && showSkipCache !== undefined;
        const episodeKey =
          presetSeason !== undefined && presetEpisode !== undefined
            ? `${presetSeason}:${presetEpisode}`
            : null;
        const skipMarkers =
          isTvSource && episodeKey
            ? showSkipCache.markersByEpisode[episodeKey] ?? []
            : undefined;
        return {
          filename: file.filename,
          sizeMb: file.sizeMb ?? null,
          sourceQuality: file.sourceQuality,
          desiredFormats,
          hints: emittedHints,
          audioOverrides: sanitizeOverrides(file.audioTrackOverrides),
          subtitleOverrides: sanitizeOverrides(file.subtitleTrackOverrides),
          ...(isTvSource ? { skipMarkers, showSkipCache } : {}),
        };
      });
    });
};
