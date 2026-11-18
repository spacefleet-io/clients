import { z } from "zod";

export const APP_IDS = ["badger", "parrot"] as const;
export const appIdSchema = z.enum(APP_IDS);
export type AppId = z.infer<typeof appIdSchema>;

export const RUNTIME_ERROR_CODES = [
  "unauthorized",
  "forbidden_scope",
  "module_not_installed",
  "module_not_ready",
  "invalid_command",
  "invalid_payload",
  "version_conflict",
  "lineage_conflict",
  "quota_exceeded",
  "retry_later",
  "internal_error",
] as const;

export const runtimeErrorCodeSchema = z.enum(RUNTIME_ERROR_CODES);
export type RuntimeErrorCode = z.infer<typeof runtimeErrorCodeSchema>;

export const runtimeErrorEnvelopeSchema = z.object({
  code: runtimeErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()),
});
export type RuntimeErrorEnvelope = z.infer<typeof runtimeErrorEnvelopeSchema>;

export const runtimeCommandRequestSchema = z.object({
  requestId: z.string(),
  module: appIdSchema,
  command: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type RuntimeCommandRequest = z.infer<typeof runtimeCommandRequestSchema>;

export const runtimeCommandResponseOkSchema = z.object({
  requestId: z.string(),
  ok: z.literal(true),
  result: z.unknown(),
  error: z.null(),
});

export const runtimeCommandResponseErrorSchema = z.object({
  requestId: z.string(),
  ok: z.literal(false),
  result: z.null(),
  error: runtimeErrorEnvelopeSchema,
});

export const runtimeCommandResponseSchema = z.union([
  runtimeCommandResponseOkSchema,
  runtimeCommandResponseErrorSchema,
]);

/**
 * Runtime command response envelope.
 *
 * The Zod schema validates `result` as `z.unknown()` at the wire boundary —
 * each command's `resultSchema` is what actually narrows the shape. The
 * TypeScript type below adds a generic so callers that know the command
 * contract get a typed result, while the default (`any`) preserves the
 * pre-typing ergonomics for callers that index `response.result.field`
 * dynamically (e.g. integration tests calling `module.execute()` directly).
 *
 * To get a typed view, use `ResultOf<typeof someCommand>` or pass the result
 * type explicitly: `RuntimeCommandResponse<{ jobs: Job[] }>`.
 */
export type RuntimeCommandResponseOk<TResult = any> = {
  requestId: string;
  ok: true;
  result: TResult;
  error: null;
};

export type RuntimeCommandResponseError = {
  requestId: string;
  ok: false;
  result: null;
  error: RuntimeErrorEnvelope;
};

export type RuntimeCommandResponse<TResult = any> =
  | RuntimeCommandResponseOk<TResult>
  | RuntimeCommandResponseError;

/**
 * Extract the result type from a CommandContract-shaped object.
 * Use this with sendCommand callers or anywhere a contract is in scope to
 * narrow `RuntimeCommandResponse` to the contract's resultSchema.
 */
export type ResultOf<C> = C extends { resultSchema: z.ZodType<infer R> } ? R : never;

export type RuntimeCommandContext = {
  backendToken: string | null;
};

export const wsClientFrameSchema = z.union([
  z.object({ type: z.literal("subscribe"), apps: z.array(appIdSchema), channels: z.array(z.string()) }),
  z.object({ type: z.literal("ack"), lastEventId: z.string() }),
]);
export type WsClientFrame = z.infer<typeof wsClientFrameSchema>;

export const runtimeEventFrameSchema = z.object({
  eventId: z.string(),
  sequence: z.number(),
  app: appIdSchema,
  channel: z.string(),
  event: z.string(),
  ts: z.string(),
  payload: z.record(z.string(), z.unknown()),
});
export type RuntimeEventFrame = z.infer<typeof runtimeEventFrameSchema>;
