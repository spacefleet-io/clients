/**
 * DEV-LIB-01: the wire contract of per-tool library access.
 *
 * A third-party tool (the CLI, a script) never logs in to the runtime. It asks
 * for access (`POST /runtime/access/request`), the user approves it in the
 * desktop app, and the tool collects a short-lived `tool` session token it can
 * only spend on the fixed list of operations below (`POST /runtime/tool/<op>`).
 * Runtime side: `apps/runtime/src/core/toolAccess.ts`.
 */
import { z } from "zod";

/** Global (`runtime.*`) WS channel on which the runtime publishes pending requests and grants to the desktop apps. */
export const TOOL_ACCESS_CHANNEL = "runtime.access";
export const TOOL_ACCESS_EVENT = "runtime.access.updated";

export const TOOL_NAME_MAX_LENGTH = 64;
export const TOOL_REASON_MAX_LENGTH = 200;

export const toolAccessModeSchema = z.enum(["read", "write"]);
export type ToolAccessMode = z.infer<typeof toolAccessModeSchema>;

/** Operations every grant may call. */
export const TOOL_READ_OPERATIONS = [
  "listMedia",
  "getMediaDetails",
  "listPlaylists",
  "listPlaylistItems",
  "listLocalDownloads",
  "getDesktopPlayback",
] as const;
/** Operations that need a grant of mode `write`. */
export const TOOL_WRITE_OPERATIONS = [
  "setProgress",
  "updateMediaMetadata",
  "createPlaylist",
  "addToPlaylist",
  "removeFromPlaylist",
  "playOnDesktop",
] as const;
export const TOOL_OPERATIONS = [...TOOL_READ_OPERATIONS, ...TOOL_WRITE_OPERATIONS] as const;
export type ToolOperation = (typeof TOOL_OPERATIONS)[number];

/**
 * PLAT-WEB-04: the operations that hand playback to the Badger desktop player.
 * The runtime answers them from its hand-off manager; they reach the library
 * only to check that the media exists.
 */
export const TOOL_HANDOFF_OPERATIONS = ["playOnDesktop", "getDesktopPlayback"] as const satisfies readonly ToolOperation[];

export const isToolOperation = (value: string): value is ToolOperation =>
  (TOOL_OPERATIONS as readonly string[]).includes(value);
export const isToolWriteOperation = (value: ToolOperation): boolean =>
  (TOOL_WRITE_OPERATIONS as readonly string[]).includes(value);
/** Operations a grant of `mode` may call. */
export const toolOperationsForMode = (mode: ToolAccessMode): ToolOperation[] =>
  mode === "write" ? [...TOOL_OPERATIONS] : [...TOOL_READ_OPERATIONS];

/** Path of a tool operation on the runtime. */
export const toolOperationPath = (operation: ToolOperation): string => `/runtime/tool/${operation}`;

/** `error` values the access and tool routes answer with. */
export const TOOL_ACCESS_ERRORS = {
  invalidPayload: "invalid_payload",
  payloadTooLarge: "payload_too_large",
  forbiddenOrigin: "forbidden_origin",
  noAppConnected: "no_app_connected",
  tooManyPending: "too_many_pending_requests",
  alreadyPending: "request_already_pending",
  alreadyDecided: "already_decided",
  rateLimited: "rate_limited",
  notFound: "not_found",
  invalidPollSecret: "invalid_poll_secret",
  denied: "denied",
  expired: "expired",
  claimed: "already_claimed",
  notAppSession: "app_session_required",
  toolNotAllowed: "tool_not_allowed",
  writeNotGranted: "write_not_granted",
  libraryLocked: "library_locked",
  operationFailed: "operation_failed",
  unauthorized: "unauthorized",
  noDesktopPlayer: "no_desktop_player",
} as const;
export type ToolAccessError = (typeof TOOL_ACCESS_ERRORS)[keyof typeof TOOL_ACCESS_ERRORS];

// --- Access request (tool -> runtime) ---

export const toolAccessRequestSchema = z
  .object({
    toolName: z.string().min(1).max(TOOL_NAME_MAX_LENGTH),
    reason: z.string().max(TOOL_REASON_MAX_LENGTH).optional(),
    mode: toolAccessModeSchema,
  })
  .strict();
export type ToolAccessRequest = z.infer<typeof toolAccessRequestSchema>;

export const toolAccessRequestResponseSchema = z.object({
  requestId: z.string().min(1),
  /** 256-bit secret only the requester ever sees; the one credential of the poll route. */
  pollSecret: z.string().min(1),
  /** Shown by the tool and by the desktop prompt: the user compares the two. */
  verificationCode: z.string().min(1),
  expiresAt: z.string(),
});
export type ToolAccessRequestResponse = z.infer<typeof toolAccessRequestResponseSchema>;

export const toolAccessPollRequestSchema = z.object({ pollSecret: z.string().min(1).max(256) }).strict();

export const toolAccessTokenResponseSchema = z.object({
  token: z.string().min(1),
  expiresAt: z.string(),
  grantId: z.string().min(1),
  mode: toolAccessModeSchema,
  allowedOps: z.array(z.string()),
});
export type ToolAccessTokenResponse = z.infer<typeof toolAccessTokenResponseSchema>;

// --- Decision and views (desktop app <-> runtime) ---

export const toolAccessDecisionSchema = z
  .object({
    decision: z.enum(["approve", "deny"]),
    /** Approve with less than was asked (`read` for a `write` request). Never more. */
    mode: toolAccessModeSchema.optional(),
  })
  .strict();
export type ToolAccessDecision = z.infer<typeof toolAccessDecisionSchema>;

export const toolAccessPendingSchema = z.object({
  requestId: z.string(),
  /** Self-declared by the requester: NOT an identity. */
  toolName: z.string(),
  reason: z.string().nullable(),
  mode: toolAccessModeSchema,
  verificationCode: z.string(),
  requestedAt: z.string(),
  expiresAt: z.string(),
});
export type ToolAccessPending = z.infer<typeof toolAccessPendingSchema>;

export const toolAccessGrantSchema = z.object({
  grantId: z.string(),
  toolName: z.string(),
  mode: toolAccessModeSchema,
  grantedAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string(),
});
export type ToolAccessGrant = z.infer<typeof toolAccessGrantSchema>;

export const toolAccessSnapshotSchema = z.object({
  pending: z.array(toolAccessPendingSchema),
  grants: z.array(toolAccessGrantSchema),
});
export type ToolAccessSnapshot = z.infer<typeof toolAccessSnapshotSchema>;

export const toolAccessGrantsResponseSchema = z.object({ grants: z.array(toolAccessGrantSchema) });

/** Every refusal of the access and tool routes: a stable code and a message safe to show. */
export const toolAccessErrorSchema = z.object({ error: z.string(), message: z.string().optional() });
export type ToolAccessErrorBody = z.infer<typeof toolAccessErrorSchema>;

// --- Tool operations: input schemas (the runtime validates, the CLI reuses them) ---

const id = z.string().min(1).max(128);
const optionalText = (max: number) => z.string().max(max).nullable().optional();

export const toolOperationInputSchemas = {
  listMedia: z
    .object({
      type: z.enum(["movie", "tv"]).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      offset: z.number().int().min(0).optional(),
    })
    .strict(),
  getMediaDetails: z.object({ mediaId: id }).strict(),
  listPlaylists: z.object({}).strict(),
  listPlaylistItems: z.object({ playlistId: id }).strict(),
  listLocalDownloads: z.object({ mediaIds: z.array(id).max(200).optional() }).strict(),
  setProgress: z
    .object({
      mediaId: id,
      progressPct: z.number().min(0).max(100),
      episodeId: id.nullable().optional(),
      positionSeconds: z.number().min(0).max(1_000_000).optional(),
      durationSeconds: z.number().min(0).max(1_000_000).optional(),
    })
    .strict(),
  updateMediaMetadata: z
    .object({
      mediaId: id,
      media: z
        .object({
          title: z.string().min(1).max(300).optional(),
          originalTitle: optionalText(300),
          originalLanguage: optionalText(16),
          overview: optionalText(5000),
          year: optionalText(16),
        })
        .strict()
        .refine((value) => Object.keys(value).length > 0, { message: "media must set at least one field" }),
    })
    .strict(),
  createPlaylist: z.object({ name: z.string().trim().min(1).max(100) }).strict(),
  addToPlaylist: z.object({ playlistId: id, mediaId: id }).strict(),
  removeFromPlaylist: z.object({ playlistId: id, mediaId: id }).strict(),
  playOnDesktop: z.object({ mediaId: id }).strict(),
  getDesktopPlayback: z.object({ handoffId: id }).strict(),
} satisfies Record<ToolOperation, z.ZodType>;

export type ToolOperationInput<Op extends ToolOperation> = z.infer<(typeof toolOperationInputSchemas)[Op]>;

// --- Desktop hand-off (PLAT-WEB-04): web player -> runtime -> Badger desktop player ---

/** Scoped WS channel (app `badger`) on which the runtime asks the desktop app to play. Live only. */
export const DESKTOP_HANDOFF_CHANNEL = "badger.handoff";
export const DESKTOP_HANDOFF_PLAY_EVENT = "badger.handoff.play";

export const desktopPlaybackStateNameSchema = z.enum(["requested", "starting", "playing", "closed", "failed"]);
export type DesktopPlaybackStateName = z.infer<typeof desktopPlaybackStateNameSchema>;

/** `getDesktopPlayback` answer. */
export const desktopPlaybackStateSchema = z.object({
  handoffId: z.string(),
  mediaId: z.string(),
  state: desktopPlaybackStateNameSchema,
  positionSeconds: z.number().nullable(),
  durationSeconds: z.number().nullable(),
  updatedAt: z.string(),
  error: z.string().nullable(),
});
export type DesktopPlaybackState = z.infer<typeof desktopPlaybackStateSchema>;

/** `playOnDesktop` answer. */
export const playOnDesktopResponseSchema = z.object({ handoffId: z.string() });
export type PlayOnDesktopResponse = z.infer<typeof playOnDesktopResponseSchema>;

/** Payload of `badger.handoff.play`. */
export const desktopHandoffPlayPayloadSchema = z.object({
  handoffId: z.string(),
  mediaId: z.string(),
  requestedAt: z.string(),
});
export type DesktopHandoffPlayPayload = z.infer<typeof desktopHandoffPlayPayloadSchema>;

/** Body of `POST /runtime/handoff/:id/state` (desktop app -> runtime). */
export const desktopHandoffReportSchema = z
  .object({
    state: z.enum(["starting", "playing", "closed", "failed"]),
    positionSeconds: z.number().min(0).max(1_000_000).optional(),
    durationSeconds: z.number().min(0).max(1_000_000).optional(),
    error: z.string().max(200).optional(),
  })
  .strict();
export type DesktopHandoffReport = z.infer<typeof desktopHandoffReportSchema>;

/** `error` values a hand-off ends with. */
export const DESKTOP_HANDOFF_ERRORS = {
  superseded: "superseded",
  desktopUnresponsive: "desktop_unresponsive",
  revoked: "revoked",
} as const;

/** `GET /runtime/web/status` answer (no auth). */
export const runtimeWebStatusSchema = z.object({ runtime: z.literal("spacefleet"), desktopPlayer: z.boolean() });
export type RuntimeWebStatus = z.infer<typeof runtimeWebStatusSchema>;
