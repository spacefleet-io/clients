/**
 * Renderer-side typed wrappers around the export IPC bridge (`window.sf.exportFiles`): "Download file"
 * (OFFL-FILE-01) and "Download everything" (ACCT-EXPORT-01). Payloads are checked against the contract schema before
 * they cross IPC and results are parsed back, like `offlineIpc.ts`. A folder must come from `pickExportFolder`: main
 * refuses any other (`errorCode: "dest_not_picked"`).
 */
import {
  badgerExportEstimatePayloadSchema,
  badgerExportEstimateResultSchema,
  badgerExportSubmitPayloadSchema,
  badgerExportSubmitResultSchema,
  type BadgerExportEstimatePayload,
  type BadgerExportEstimateResult,
  type BadgerExportSubmitPayload,
  type BadgerExportSubmitResult,
} from "@space/runtime-contracts/badger/export";
import { isOfflineIpcError, type OfflineIpcError } from "./offlineIpc";

export type ExportIpcError = OfflineIpcError;
export const isExportIpcError = isOfflineIpcError;

export class ExportIpcUnavailableError extends Error {
  constructor(method: string) {
    super(`window.sf.exportFiles.${method} is not available (no preload bridge)`);
    this.name = "ExportIpcUnavailableError";
  }
}

type Issue = { path: PropertyKey[]; message: string };
const formatIssues = (issues: Issue[]) =>
  issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`).join("; ");

const getBridge = () => (typeof window === "undefined" ? null : (window.sf?.exportFiles ?? null));

/** The folder the user picked for exported files; null when they cancelled. */
export const pickExportFolder = async (): Promise<string | null> => {
  const bridge = getBridge();
  if (!bridge?.pickFolder) throw new ExportIpcUnavailableError("pickFolder");
  return (await bridge.pickFolder()) ?? null;
};

export const callExportEstimate = async (
  payload: BadgerExportEstimatePayload,
): Promise<BadgerExportEstimateResult | ExportIpcError> => {
  const checked = badgerExportEstimatePayloadSchema.safeParse(payload);
  if (!checked.success) throw new Error(`Invalid payload for exportFiles.estimate: ${formatIssues(checked.error.issues)}`);
  const bridge = getBridge();
  if (!bridge?.estimate) throw new ExportIpcUnavailableError("estimate");
  const raw = await bridge.estimate(checked.data);
  if (isExportIpcError(raw)) return raw;
  const parsed = badgerExportEstimateResultSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`exportFiles.estimate returned an unexpected shape: ${formatIssues(parsed.error.issues)}`);
  return parsed.data;
};

export const callExportSubmit = async (
  payload: BadgerExportSubmitPayload,
): Promise<BadgerExportSubmitResult | ExportIpcError> => {
  const checked = badgerExportSubmitPayloadSchema.safeParse(payload);
  if (!checked.success) throw new Error(`Invalid payload for exportFiles.submit: ${formatIssues(checked.error.issues)}`);
  const bridge = getBridge();
  if (!bridge?.submit) throw new ExportIpcUnavailableError("submit");
  const raw = await bridge.submit(checked.data);
  if (isExportIpcError(raw)) return raw;
  const parsed = badgerExportSubmitResultSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`exportFiles.submit returned an unexpected shape: ${formatIssues(parsed.error.issues)}`);
  return parsed.data;
};
