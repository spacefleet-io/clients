import { z } from "zod";
import { defineCommand } from "../helpers";

export const badgerPlaybackPrepareStream = defineCommand({
  name: "badger.playback.prepare_stream" as const,
  module: "badger",
  payloadSchema: z.object({
    sessionId: z.string().optional(),
    kind: z.enum(["hls", "stream"]).optional(),
    url: z.string().optional(),
    contentType: z.string().optional(),
    totalSize: z.number().min(0).optional(),
    mode: z.enum(["event", "vod"]).optional(),
    videoTrackCount: z.number().min(0).optional(),
    audioTrackCount: z.number().min(0).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  resultSchema: z.object({
    sessionId: z.string(),
    kind: z.string(),
    url: z.string().nullable(),
    contentType: z.string().nullable(),
    totalSize: z.number().nullable(),
    mode: z.string().nullable(),
    videoTrackCount: z.number().nullable(),
    audioTrackCount: z.number().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    releasedAt: z.string().nullable(),
  }),
});

export const badgerPlaybackReleaseStream = defineCommand({
  name: "badger.playback.release_stream" as const,
  module: "badger",
  payloadSchema: z.object({
    sessionId: z.string().min(1),
  }),
  resultSchema: z.object({
    released: z.boolean(),
    sessionId: z.string(),
    releasedAt: z.string().optional(),
    reason: z.string().optional(),
  }),
});

export const badgerPlaybackListActiveSessions = defineCommand({
  name: "badger.playback.list_active_sessions" as const,
  module: "badger",
  payloadSchema: z.object({
    includeReleased: z.boolean().optional(),
    kind: z.enum(["stream", "hls"]).optional(),
  }),
  resultSchema: z.object({
    listedAt: z.string(),
    total: z.number(),
    includeReleased: z.boolean(),
    sessions: z.array(z.record(z.string(), z.unknown())),
  }),
});

export const badgerPlaybackRecordSignedUrlRequest = defineCommand({
  name: "badger.playback.record_signed_url_request" as const,
  module: "badger",
  payloadSchema: z.object({
    increment: z.number().int().positive().optional(),
  }),
  resultSchema: z.object({
    requests: z.number(),
    resetAt: z.string(),
  }),
});

export const badgerPlaybackGetSignedUrlMetrics = defineCommand({
  name: "badger.playback.get_signed_url_metrics" as const,
  module: "badger",
  payloadSchema: z.object({}),
  resultSchema: z.object({
    requests: z.number(),
    resetAt: z.string(),
  }),
});

export const badgerPlaybackResetSignedUrlMetrics = defineCommand({
  name: "badger.playback.reset_signed_url_metrics" as const,
  module: "badger",
  payloadSchema: z.object({}),
  resultSchema: z.object({
    requests: z.literal(0),
    resetAt: z.string(),
  }),
});

/**
 * `badger.playback.set_upload_policy` (#25, Chris 2026-10-13)
 *
 * What ingest uploads do while a video plays on this computer
 * (`full` | `throttle` | `pause`). The desktop main process sends it when mpv
 * starts/stops, when the user changes the setting, and every few seconds while
 * mpv is alive. `playbackActive: true` is a LEASE (`leaseMs`, default 15 s, max
 * 60 s): when the renewals stop (mpv or the app crashed) the runtime goes back
 * to full speed on its own, so a pause can never get stuck. Idempotent.
 */
export const badgerPlaybackSetUploadPolicy = defineCommand({
  name: "badger.playback.set_upload_policy" as const,
  module: "badger",
  payloadSchema: z.object({
    mode: z.enum(["full", "throttle", "pause"]),
    playbackActive: z.boolean(),
    leaseMs: z.number().int().min(0).max(60_000).optional(),
  }),
  resultSchema: z.object({
    mode: z.enum(["full", "throttle", "pause"]),
    playbackActive: z.boolean(),
    effective: z.enum(["full", "throttle", "pause"]),
  }),
});
