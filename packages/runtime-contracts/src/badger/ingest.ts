/**
 * @deprecated The action-union commands (`badger.ingest.apply`, queue_files,
 * start_job, cancel_job, remove_job, etc.) are scheduled for removal in
 * Phase D of the ingestion refactor (multi-job per ingest, 2026-05-01).
 *
 * New code should use:
 *   - badger.ingest.submit_sources
 *   - badger.ingest.attach_metadata
 *   - badger.ingest.plan_outputs
 *   - runtime.jobs.cancel
 *   - runtime.jobs.dismiss
 *
 * Legacy schemas remain exported until Phase D's renderer rewrite lands.
 */
import { z } from "zod";
import { defineCommand } from "../helpers";

export const badgerIngestOpen = defineCommand({
  name: "badger.ingest.open" as const,
  module: "badger",
  payloadSchema: z.object({
    userId: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
  }),
  resultSchema: z.object({
    userId: z.string(),
    openedAt: z.string(),
    updatedAt: z.string(),
    totalJobs: z.number(),
    jobs: z.array(z.record(z.string(), z.unknown())).optional(),
  }),
});

export const badgerIngestClose = defineCommand({
  name: "badger.ingest.close" as const,
  module: "badger",
  payloadSchema: z.object({
    userId: z.string().optional(),
  }),
  resultSchema: z.object({
    closed: z.boolean(),
    reason: z.string().optional(),
    userId: z.string().optional(),
    jobs: z.number().optional(),
    closedAt: z.string().optional(),
  }),
});

export const badgerIngestGetState = defineCommand({
  name: "badger.ingest.get_state" as const,
  module: "badger",
  payloadSchema: z.object({}),
  resultSchema: z.object({
    activeUserId: z.string().nullable(),
    opened: z.boolean(),
    totalJobs: z.number(),
    statusCounts: z.record(z.string(), z.number()),
    updatedAt: z.string().nullable(),
  }),
});

/** Alias for badger.ingest.get_state */
export const badgerIngestGetStateAlias = defineCommand({
  name: "badger.ingest.getState" as const,
  module: "badger",
  payloadSchema: badgerIngestGetState.payloadSchema,
  resultSchema: badgerIngestGetState.resultSchema,
});

export const badgerIngestApply = defineCommand({
  name: "badger.ingest.apply" as const,
  module: "badger",
  payloadSchema: z.object({
    userId: z.string().optional(),
    actions: z.array(z.record(z.string(), z.unknown())),
  }),
  resultSchema: z.object({
    userId: z.string(),
    changed: z.boolean(),
    updatedAt: z.string(),
    totalJobs: z.number(),
    jobs: z.array(z.record(z.string(), z.unknown())).optional(),
  }),
});

export const badgerIngestListJobs = defineCommand({
  name: "badger.ingest.list_jobs" as const,
  module: "badger",
  payloadSchema: z.object({
    status: z.string().optional(),
    limit: z.number().int().positive().optional(),
  }),
  resultSchema: z.object({
    userId: z.string().nullable(),
    opened: z.boolean(),
    jobs: z.array(z.record(z.string(), z.unknown())),
    total: z.number(),
    listedAt: z.string(),
  }),
});

// ---------------------------------------------------------------------------
// New typed ingest submission API (Phase D target).
// See plan §7 "Submission API" and §1 "Job model".
// ---------------------------------------------------------------------------

/** Quality variant union — keep narrow, expand later via settings. */
export const badgerIngestQualitySchema = z.enum([
  "1080p",
  "720p",
  "480p",
  "360p",
  "240p",
  "144p",
]);

/**
 * User override for an audio or subtitle track whose container metadata is
 * `und` or otherwise unhelpful. The renderer collects these in the ingest
 * dialog when the user picks a language for an undefined track and types a
 * custom display label.
 *
 * `index` is the AUDIO-ONLY (or SUBTITLE-ONLY) index — i.e. the position in
 * the audio-only / subtitle-only filtered stream list, NOT the absolute
 * ffprobe stream index. The renderer is responsible for converting from the
 * absolute probe-stream index it shows in the UI to the per-kind index used
 * here. This matches the contract `mediaProcessor.ts` already enforces when
 * iterating audio/subtitle streams (see `audioStreams = streams.filter(...)`
 * loops in packages/ingest-core).
 *
 * Bug #4 (audio language override dropped): without this field on the
 * submit payload, the user-typed language never reached the runtime and the
 * encoded audio shipped with `language='und', label='Undefined'` regardless
 * of what the user picked.
 */
export const badgerIngestTrackOverrideSchema = z.object({
  index: z.number().int().nonnegative(),
  language: z.string().min(2).max(8),
  label: z.string(),
});

export type BadgerIngestTrackOverride = z.infer<
  typeof badgerIngestTrackOverrideSchema
>;

/**
 * Per-episode intro/credits marker fetched from the TheIntroDB provider at
 * import-modal identify time. The renderer carries one of these per file (for
 * the file's specific episode); the runtime persists it on commit so the
 * lazy-fetch on first playback can be skipped.
 *
 * Movies omit this field entirely. TV sources with no markers found send an
 * empty array (so the runtime can distinguish "no data" from "didn't try").
 */
export const badgerIngestSkipMarkerSchema = z.object({
  type: z.enum(["intro", "credits"]),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().nonnegative(),
  source: z.string(),
  confidence: z.number().nullable().optional(),
});

export type BadgerIngestSkipMarker = z.infer<typeof badgerIngestSkipMarkerSchema>;

/**
 * Full-show coverage + per-episode markers payload. Carried on every source-job
 * for a TV show so the runtime can refresh the local show-cache row on commit.
 * Idempotent overwrite — same payload across multiple files of the same show
 * just refreshes the timestamp. Movies omit entirely.
 *
 * Stored in `media_skip_analysis` with `kind = "external-skip-markers-show-v1"`
 * keyed by the show's media_items.id (episode_id = null). Subsequent modal
 * opens of any episode from the same show hit this cache instead of the API.
 */
export const badgerIngestShowSkipCacheSchema = z.object({
  provider: z.string(),
  showTmdbId: z.number().int().positive(),
  fetchedAt: z.string(),
  coverage: z.array(
    z.object({
      seasonNumber: z.number().int().positive(),
      episodeNumber: z.number().int().positive(),
      status: z.enum(["hit", "miss", "pending_detail"]),
      markerTypes: z.array(z.enum(["intro", "credits"])).optional(),
    }),
  ),
  markersByEpisode: z.record(
    z.string(),
    z.array(badgerIngestSkipMarkerSchema),
  ),
});

export type BadgerIngestShowSkipCache = z.infer<
  typeof badgerIngestShowSkipCacheSchema
>;

/** One source descriptor in a submission. */
export const badgerIngestSubmitSourceItemSchema = z.object({
  filename: z.string().min(1),
  sizeMb: z.number().nonnegative().nullable().optional(),
  sourceQuality: z.string().optional(), // e.g., "1080p" detected from container
  desiredFormats: z.array(badgerIngestQualitySchema).default([]),
  hints: z
    .object({
      mediaId: z.string().optional(),
      pendingMediaPayload: z.unknown().optional(),
      season: z.number().int().positive().optional(),
      episode: z.number().int().positive().optional(),
      matchedTitle: z.string().optional(),
    })
    .optional(),
  /**
   * User overrides for `und`-language audio tracks, applied at encode time
   * via `mediaProcessor.audioTrackOverrides`. See
   * `badgerIngestTrackOverrideSchema` for the index semantics. Optional —
   * sources whose audio metadata is already correct don't need any.
   */
  audioOverrides: z.array(badgerIngestTrackOverrideSchema).optional(),
  /** Same as audioOverrides, applied to subtitle tracks. */
  subtitleOverrides: z.array(badgerIngestTrackOverrideSchema).optional(),
  /**
   * Per-episode intro/credits markers for THIS file's specific episode.
   * Optional; omitted for movies and for TV when the renderer couldn't fetch
   * (network failure, no coverage from provider). An empty array means
   * "fetched and provider has no markers for this episode" — distinguishable
   * from undefined ("didn't try").
   */
  skipMarkers: z.array(badgerIngestSkipMarkerSchema).optional(),
  /**
   * Full-show coverage + per-episode markers cache. Carried on every TV
   * source-job so the runtime can refresh the local show-cache row at commit
   * time. Idempotent across multiple files of the same show. Movies omit.
   */
  showSkipCache: badgerIngestShowSkipCacheSchema.optional(),
  /**
   * Optional client-supplied dedupe key. The runtime computes one if absent
   * (`${userId}|${filename}|source`). Defense-in-depth against duplicate
   * submissions — the SQLite store has a unique index on
   * `(app, dedupe_key) WHERE dedupe_key IS NOT NULL`.
   */
  dedupeKey: z.string().optional(),
});

export type BadgerIngestSubmitSourceItem = z.infer<
  typeof badgerIngestSubmitSourceItemSchema
>;

/**
 * What a client sends for one source, before schema defaults apply. Clients
 * that relay sources (the desktop main process) type their forwarding with
 * this so a field added to the schema cannot be silently dropped again.
 */
export type BadgerIngestSubmitSourceItemInput = z.input<
  typeof badgerIngestSubmitSourceItemSchema
>;

/** Top-level submit_sources command. */
export const badgerIngestSubmitSources = defineCommand({
  name: "badger.ingest.submit_sources" as const,
  module: "badger",
  payloadSchema: z.object({
    userId: z.string().min(1),
    sources: z.array(badgerIngestSubmitSourceItemSchema).min(1),
  }),
  resultSchema: z.object({
    submitted: z.array(
      z.object({
        groupId: z.string(), // = mediaId or pending placeholder
        sourceJobId: z.string(),
        /**
         * Per-media silo placement (#145) every object of this source lands
         * under. Clients adding objects to the same media during the same
         * submit (subtitles attached in the import dialog) upload under it.
         * Null only for a deduped legacy source whose job id is not a valid
         * placement id (its steps mint one later).
         */
        placementId: z.string().nullable(),
        formatJobIds: z.array(
          z.object({
            variant: badgerIngestQualitySchema,
            jobId: z.string(),
          }),
        ),
      }),
    ),
  }),
});

/** Attach metadata to an in-flight ingest (transitions identify → ready). */
export const badgerIngestAttachMetadata = defineCommand({
  name: "badger.ingest.attach_metadata" as const,
  module: "badger",
  payloadSchema: z.object({
    jobId: z.string(), // the source job's id
    mediaId: z.string().optional(),
    pendingMediaPayload: z.unknown().optional(),
    season: z.number().int().positive().optional(),
    episode: z.number().int().positive().optional(),
  }),
  resultSchema: z.object({
    attached: z.boolean(),
    jobId: z.string(),
  }),
});

/**
 * `badger.ingest.configure_scheduling`
 *
 * Binds the desktop ingest-concurrency settings to the live engineV2 lane
 * caps. `maxParallelTranscodes` drives the `format` (transcode) lane;
 * `maxParallelExtractions` drives the `source` (probe/identify/extract/commit)
 * lane. Both are clamped 1..3 on the wire; the engine clamps again to `>= 1`
 * defensively. The renderer fires this on app mount and whenever either
 * setting changes so caps apply live without a runtime restart.
 *
 * `applied: false` (with `caps` omitted) is the graceful response when
 * engineV2 is unavailable (boot failed / disabled) — the handler never
 * throws for that case.
 */
export const badgerIngestConfigureScheduling = defineCommand({
  name: "badger.ingest.configure_scheduling" as const,
  module: "badger",
  payloadSchema: z.object({
    maxParallelTranscodes: z.number().int().min(1).max(3),
    maxParallelExtractions: z.number().int().min(1).max(3),
  }),
  resultSchema: z.object({
    applied: z.boolean(),
    caps: z
      .object({
        format: z.number(),
        source: z.number(),
      })
      .optional(),
  }),
});

/** Plan or update output formats for a media-item (adds/removes format jobs). */
export const badgerIngestPlanOutputs = defineCommand({
  name: "badger.ingest.plan_outputs" as const,
  module: "badger",
  payloadSchema: z.object({
    sourceJobId: z.string(),
    formats: z.array(badgerIngestQualitySchema),
  }),
  resultSchema: z.object({
    addedJobIds: z.array(
      z.object({
        variant: badgerIngestQualitySchema,
        jobId: z.string(),
      }),
    ),
    removedJobIds: z.array(z.string()),
  }),
});

// ---------------------------------------------------------------------------
// Post-ingest quality management (Phase 4 of post-ingest-qualities plan).
//
// `badger.ingest.plan_outputs` only works while the source job is alive
// (terminal source jobs return errorCode "source-terminal"). Once a media
// item is committed, the source job is `succeeded` and users still need a
// way to add or remove qualities. `badger.media.replan_qualities` is the
// post-ingest counterpart — it operates on `mediaId` + `fileId` (the
// committed file row) rather than a sourceJobId.
//
// Constraints (mirrored from the plan):
//   - removals must NOT target an `is_source = 1` row (source-protected)
//   - adds must NOT request a quality that's already present (quality-exists)
//   - adds must NOT request a higher resolution than anything available
//     (cannot-transcode-up — we never up-scale)
//   - all referenced format ids must belong to the file (media-not-found)
// ---------------------------------------------------------------------------

/**
 * Error codes surfaced by `badger.media.replan_qualities`. Returned in the
 * result envelope when validation fails (the command itself does not throw —
 * the renderer surfaces a user-friendly message keyed by code).
 */
export const badgerMediaReplanQualitiesErrorCodeSchema = z.enum([
  "source-protected",
  "quality-exists",
  "cannot-transcode-up",
  "media-not-found",
]);

export type BadgerMediaReplanQualitiesErrorCode = z.infer<
  typeof badgerMediaReplanQualitiesErrorCodeSchema
>;

export const badgerMediaReplanQualities = defineCommand({
  name: "badger.media.replan_qualities" as const,
  module: "badger",
  payloadSchema: z.object({
    /** The media_items.id whose file we're modifying. */
    mediaId: z.string().min(1),
    /** The media_files.id holding the format rows to add to / remove from. */
    fileId: z.string().min(1),
    /**
     * Qualities to add. Any subset of the canonical preset list that:
     *   - is not already present on the file
     *   - is not higher resolution than the highest available format
     * The handler picks the cheapest viable source variant per add via
     * `pickReTranscodeSource` and submits a new format job (kind="retranscode").
     */
    addQualities: z.array(badgerIngestQualitySchema),
    /**
     * media_formats.id values to remove. Must NOT include the source row
     * (is_source = 1); the handler returns errorCode "source-protected"
     * if any do.
     */
    removeFormatIds: z.array(z.string()),
  }),
  resultSchema: z.object({
    /** New format jobs created, one per `addQualities` entry on success. */
    addedJobIds: z.array(
      z.object({
        variant: badgerIngestQualitySchema,
        jobId: z.string(),
      }),
    ),
    /** Format rows actually removed. Empty if removals failed validation. */
    removedFormatIds: z.array(z.string()),
    /**
     * Set when the command rejected the request. When present, `addedJobIds`
     * and `removedFormatIds` are both empty (atomic refusal — no partial
     * application). Absent on success.
     */
    errorCode: badgerMediaReplanQualitiesErrorCodeSchema.optional(),
  }),
});

export type BadgerMediaReplanQualitiesPayload = z.infer<
  typeof badgerMediaReplanQualities.payloadSchema
>;

export type BadgerMediaReplanQualitiesResult = z.infer<
  typeof badgerMediaReplanQualities.resultSchema
>;
