import type { LibraryMeta } from "./api";

/**
 * What `GET /library/db/meta` says about the account's library.
 *
 * - `present`: a snapshot exists and is reachable.
 * - `absent`: the account has never had a library (server asks for bootstrap).
 * - `unavailable`: a library exists but its snapshot could not be confirmed
 *   right now (e.g. the storage gateway HEAD failed). The API folds that into
 *   `exists: false`, so `exists` alone must never be read as "no library":
 *   doing so showed "No media yet" on an account with a full library.
 */
export type LibraryMetaState = "present" | "absent" | "unavailable";

export const classifyLibraryMeta = (meta: Pick<LibraryMeta, "exists" | "bootstrapRequired">): LibraryMetaState => {
  if (meta.exists) return "present";
  return meta.bootstrapRequired ? "absent" : "unavailable";
};

/** A sync with the server could not be confirmed (meta not `present`, or not fetched): work that needs one must stop. */
export class LibrarySyncUnavailableError extends Error {
  constructor() {
    super("LIBRARY_SYNC_UNAVAILABLE");
    this.name = "LibrarySyncUnavailableError";
  }
}
