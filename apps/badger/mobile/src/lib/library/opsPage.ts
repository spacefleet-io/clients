/**
 * Library op pages through the native binary reader (LIB-FMT-13, LIB-SYNC-15): `GET /library/db/ops` with
 * `Accept: application/vnd.space.library-ops`, fetched, decrypted and inflated on a native worker thread, declaring
 * the op stream this build reads (`libraryReadHeaders`).
 */
import { ApiError, getApiBaseUrl } from "@space/shared/api";
import type { LibraryOp } from "@space/shared/libraryOps";
import { discardOpsPageFiles, fetchOpsPage, readOpsPageOpText, type NativeOpsPage } from "../../native/LibrarySync";
import { libraryReadHeaders } from "./libraryReads";

export type LibraryOpsPageEntry = { version: number; jsonBytes: number; op: LibraryOp };

export type LibraryOpsPage = Omit<NativeOpsPage, "ops"> & { ops: LibraryOpsPageEntry[] };

/**
 * A native `HTTP_<status>` rejection as the `ApiError` the SDK would have thrown for the same answer, so the app's
 * "please update" latch (REL-CD-29, `onApiError`) and the sync's error handling see it the same way. Any other
 * rejection is returned unchanged.
 */
export const nativeHttpError = (error: unknown): unknown => {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return error;
  const status = /^HTTP_(\d{3})$/.exec(error.code)?.[1];
  if (!status) return error;
  const body = "message" in error && typeof error.message === "string" ? error.message : "";
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = { ...parsed };
  } catch {
    // A body that is not JSON (a proxy's HTML page): the status alone.
  }
  return new ApiError(Number(status), payload);
};

/** One page of ops after `since`, parsed. A page that fails to read leaves no cache file behind. */
export const fetchLibraryOpsPage = async (token: string, keyBase64: string, since: number): Promise<LibraryOpsPage> => {
  let page: NativeOpsPage;
  try {
    page = await fetchOpsPage({
      url: `${getApiBaseUrl()}/library/db/ops`,
      headers: libraryReadHeaders(token),
      keyBase64,
      fromVersion: since,
    });
  } catch (error) {
    throw nativeHttpError(error);
  }
  try {
    const ops: LibraryOpsPageEntry[] = [];
    for (const entry of page.ops) {
      const op = JSON.parse(await readOpsPageOpText(entry)) as LibraryOp;
      ops.push({ version: entry.version, jsonBytes: entry.jsonBytes, op });
    }
    return { ...page, ops };
  } finally {
    await discardOpsPageFiles(page.ops);
  }
};
