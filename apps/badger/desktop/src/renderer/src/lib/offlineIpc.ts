/**
 * Renderer-side typed wrappers around the offline-mode IPC bridge.
 *
 * The runtime contracts in `@space/runtime-contracts/badger/offline` define
 * the Zod schemas + TS types for all five offline commands; the main
 * process validates payloads + results via `sendCommand` already. This
 * module exists so renderer code can call them as plain async helpers
 * without sprinkling `window.sf.offline.X` access patterns and without
 * losing the contract types. It also normalizes the renderer error
 * envelope (`__runtimeJobsError`) into a typed `OfflineIpcError`.
 *
 * No raw fetch — every call goes through the main-process IPC bridge in
 * `apps/badger/desktop/src/main/runtimeJobsIpc.ts`, which routes to
 * `commandClient.sendCommand(contract, payload)` (runtime contract
 * enforcement).
 */
import {
  badgerOfflineEstimateSizePayloadSchema,
  badgerOfflineEstimateSizeResultSchema,
  badgerOfflineDownloadSubmitPayloadSchema,
  badgerOfflineDownloadSubmitResultSchema,
  badgerOfflineDeleteLocalPayloadSchema,
  badgerOfflineDeleteLocalResultSchema,
  badgerOfflineListLocalPayloadSchema,
  badgerOfflineListLocalResultSchema,
  badgerOfflineReconcilePayloadSchema,
  badgerOfflineReconcileResultSchema,
} from "@space/runtime-contracts/badger/offline";

// Use the schemas' inferred output types directly via Parameters /
// ReturnType-style extraction. We don't import `zod` here because
// badger-desktop doesn't have zod as a direct dep — the schemas come
// from runtime-contracts (which does). The schemas expose `_output` for
// inferring the parsed type without needing the zod import locally.

type SchemaOf<T> = { parse(v: unknown): T; safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } } };

// Helper to extract the parsed type from a contract schema. Works for any
// Zod schema (v3 and v4) because both expose `_output`.
type Infer<S> = S extends { _output: infer O } ? O : never;

export type OfflineEstimatePayload = Infer<typeof badgerOfflineEstimateSizePayloadSchema>;
export type OfflineEstimateResult = Infer<typeof badgerOfflineEstimateSizeResultSchema>;
export type OfflineSubmitPayload = Infer<typeof badgerOfflineDownloadSubmitPayloadSchema>;
export type OfflineSubmitResult = Infer<typeof badgerOfflineDownloadSubmitResultSchema>;
export type OfflineDeletePayload = Infer<typeof badgerOfflineDeleteLocalPayloadSchema>;
export type OfflineDeleteResult = Infer<typeof badgerOfflineDeleteLocalResultSchema>;
export type OfflineListPayload = Infer<typeof badgerOfflineListLocalPayloadSchema>;
export type OfflineListResult = Infer<typeof badgerOfflineListLocalResultSchema>;
export type OfflineReconcilePayload = Infer<typeof badgerOfflineReconcilePayloadSchema>;
export type OfflineReconcileResult = Infer<typeof badgerOfflineReconcileResultSchema>;

/**
 * Renderer-side error envelope. Mirrors the `toRendererError` shape that the
 * main IPC handlers wrap exceptions in (see `runtimeJobsIpc.ts:toRendererError`).
 */
export type OfflineIpcError = {
  __runtimeJobsError: true;
  status: number;
  errorCode: string | null;
  message: string | null;
};

const isIpcError = (v: unknown): v is OfflineIpcError =>
  !!v &&
  typeof v === "object" &&
  (v as { __runtimeJobsError?: unknown }).__runtimeJobsError === true;

/**
 * Thrown when the runtime is unavailable in the renderer (no preload
 * bridge, no main-process handler, etc.). Distinct from a successful IPC
 * round-trip that returns an `OfflineIpcError` envelope.
 */
export class OfflineIpcUnavailableError extends Error {
  constructor(method: string) {
    super(`window.sf.offline.${method} is not available (no preload bridge)`);
    this.name = "OfflineIpcUnavailableError";
  }
}

/**
 * Re-validate the IPC payload against the contract schema before passing
 * it to the main bridge. Mirrors the main-process command client's
 * payload check, since the IPC layer doesn't run Zod itself — main does
 * once it reaches `sendCommand`, but a renderer-side bad payload would
 * roundtrip and fail there anyway. Validating here keeps the failure
 * mode obvious.
 */
const validate = <S extends SchemaOf<unknown>>(
  schema: S,
  input: unknown,
  methodName: string,
): Infer<S> => {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((i: { path: PropertyKey[]; message: string }) =>
        `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`,
      )
      .join("; ");
    throw new Error(`Invalid payload for offline.${methodName}: ${issues}`);
  }
  return result.data as Infer<S>;
};

/**
 * Parse and narrow an IPC result against the contract's result schema.
 * Throws if the runtime returned an unexpected shape — which would be a
 * contract drift bug we want to fail loud on.
 */
const parseResult = <S extends SchemaOf<unknown>>(
  schema: S,
  raw: unknown,
  methodName: string,
): Infer<S> | OfflineIpcError => {
  if (isIpcError(raw)) return raw;
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i: { path: PropertyKey[]; message: string }) =>
        `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`,
      )
      .join("; ");
    throw new Error(
      `offline.${methodName} returned an unexpected shape: ${issues}`,
    );
  }
  return result.data as Infer<S>;
};

const getBridge = () =>
  (globalThis as { window?: Window }).window?.sf?.offline ?? null;

export const callOfflineEstimate = async (
  payload: OfflineEstimatePayload,
): Promise<OfflineEstimateResult | OfflineIpcError> => {
  const validated = validate(badgerOfflineEstimateSizePayloadSchema, payload, "estimate");
  const bridge = getBridge();
  if (!bridge?.estimate) throw new OfflineIpcUnavailableError("estimate");
  const raw = await bridge.estimate(validated);
  return parseResult(badgerOfflineEstimateSizeResultSchema, raw, "estimate");
};

export const callOfflineDownloadSubmit = async (
  payload: OfflineSubmitPayload,
): Promise<OfflineSubmitResult | OfflineIpcError> => {
  const validated = validate(badgerOfflineDownloadSubmitPayloadSchema, payload, "downloadSubmit");
  const bridge = getBridge();
  if (!bridge?.downloadSubmit) throw new OfflineIpcUnavailableError("downloadSubmit");
  const raw = await bridge.downloadSubmit(validated);
  return parseResult(badgerOfflineDownloadSubmitResultSchema, raw, "downloadSubmit");
};

export const callOfflineDeleteLocal = async (
  payload: OfflineDeletePayload,
): Promise<OfflineDeleteResult | OfflineIpcError> => {
  const validated = validate(badgerOfflineDeleteLocalPayloadSchema, payload, "deleteLocal");
  const bridge = getBridge();
  if (!bridge?.deleteLocal) throw new OfflineIpcUnavailableError("deleteLocal");
  const raw = await bridge.deleteLocal(validated);
  return parseResult(badgerOfflineDeleteLocalResultSchema, raw, "deleteLocal");
};

export const callOfflineListLocal = async (
  payload: OfflineListPayload = {},
): Promise<OfflineListResult | OfflineIpcError> => {
  const validated = validate(badgerOfflineListLocalPayloadSchema, payload, "listLocal");
  const bridge = getBridge();
  if (!bridge?.listLocal) throw new OfflineIpcUnavailableError("listLocal");
  const raw = await bridge.listLocal(validated);
  return parseResult(badgerOfflineListLocalResultSchema, raw, "listLocal");
};

export const callOfflineReconcile = async (
  payload: OfflineReconcilePayload = {},
): Promise<OfflineReconcileResult | OfflineIpcError> => {
  const validated = validate(badgerOfflineReconcilePayloadSchema, payload, "reconcile");
  const bridge = getBridge();
  if (!bridge?.reconcile) throw new OfflineIpcUnavailableError("reconcile");
  const raw = await bridge.reconcile(validated);
  return parseResult(badgerOfflineReconcileResultSchema, raw, "reconcile");
};

export const isOfflineIpcError = isIpcError;
