import { z } from "zod";

// --- Connection handshake ---

export const runtimeConnectRequestSchema = z.object({
  appName: z.string().min(1),
  pid: z.number().int().positive(),
});
export type RuntimeConnectRequest = z.infer<typeof runtimeConnectRequestSchema>;

export const runtimeConnectionEntrySchema = z.object({
  connectionId: z.string(),
  appName: z.string(),
  connectedAt: z.string(),
});
export type RuntimeConnectionEntry = z.infer<typeof runtimeConnectionEntrySchema>;

export const runtimeConnectResponseSchema = z.object({
  connectionId: z.string(),
  connectedApps: z.array(runtimeConnectionEntrySchema),
});
export type RuntimeConnectResponse = z.infer<typeof runtimeConnectResponseSchema>;

export const runtimeDisconnectRequestSchema = z.object({
  connectionId: z.string().min(1),
});
export type RuntimeDisconnectRequest = z.infer<typeof runtimeDisconnectRequestSchema>;

export const runtimeDisconnectResponseSchema = z.object({
  ok: z.literal(true),
  remaining: z.number().int().nonnegative(),
});
export type RuntimeDisconnectResponse = z.infer<typeof runtimeDisconnectResponseSchema>;

// --- Owner secret (RT-SEC-05) ---

/** Request header that carries the owner secret on `POST /runtime/session/login`. */
export const RUNTIME_OWNER_HEADER = "x-runtime-owner";
/** File in the runtime data dir that holds the owner secret of the running runtime. */
export const RUNTIME_OWNER_SECRET_FILE = "owner.secret";
/** The secret is 32 random bytes, written as this many lowercase hex characters. */
export const RUNTIME_OWNER_SECRET_HEX_LENGTH = 64;
/** `error` values of the 401/429 answers of the login gate. */
export const RUNTIME_OWNER_ERRORS = {
  required: "owner_secret_required",
  invalid: "owner_secret_invalid",
  rateLimited: "owner_secret_rate_limited",
} as const;
export type RuntimeOwnerError = (typeof RUNTIME_OWNER_ERRORS)[keyof typeof RUNTIME_OWNER_ERRORS];

// --- Session schemas (for zod validation of existing endpoints) ---

export const runtimeLoginRequestSchema = z.object({
  backendToken: z.string().min(1),
  apps: z.array(z.string()).optional(),
  userId: z.string().optional(),
});
export type RuntimeLoginRequest = z.infer<typeof runtimeLoginRequestSchema>;

// --- Session response schemas ---

export const runtimeLoginResponseSchema = z.object({
  ok: z.literal(true),
  token: z.string().min(1),
  expiresAt: z.string(),
  capabilities: z.object({
    apps: z.array(z.string()),
  }),
});
export type RuntimeLoginResponse = z.infer<typeof runtimeLoginResponseSchema>;

// --- Job filter query schema ---

export const runtimeJobFilterQuerySchema = z.object({
  app: z.string().optional(),
  status: z.string().optional(),
  kind: z.string().optional(),
  includeCompleted: z.string().optional(),
  limit: z.string().optional(),
});
export type RuntimeJobFilterQuery = z.infer<typeof runtimeJobFilterQuerySchema>;

// --- Lifecycle event payloads ---

export const lifecycleAppConnectedPayloadSchema = z.object({
  appName: z.string(),
  connectionId: z.string(),
});

export const lifecycleAppDisconnectedPayloadSchema = z.object({
  appName: z.string(),
  connectionId: z.string(),
  remainingCount: z.number().int().nonnegative(),
});
