/**
 * Every library read of this app declares the op stream this build reads (LIB-FMT-13): an account switched to op
 * stream 4 answers a read that does not state it in `x-library-op-stream-version` with 426. No native imports, so the
 * screens and the store can use it.
 */
import { getLibraryDb, getLibraryMeta } from "@space/shared/api";
import { clientIdentityHeaders } from "@space/shared/appVersion";
import { READ_OP_STREAM_VERSION } from "@space/library-db-definition/ops";

/** The op stream this build reads, sent on every library read (meta, snapshot, ops, stream). */
export const libraryReadOpStreamVersion = READ_OP_STREAM_VERSION; // op-stream: read

/** The headers of a hand-made library read: session, app, build identity and the op stream it reads. */
export const libraryReadHeaders = (token: string): Record<string, string> => ({
  ...clientIdentityHeaders(),
  Authorization: `Bearer ${token}`,
  "x-space-app": "badger",
  "x-library-op-stream-version": String(libraryReadOpStreamVersion),
});

/** `/library/db/meta` declaring the op stream this build reads (its `targetOpStreamVersion` says whether to switch). */
export const readLibraryMeta = (token: string) => getLibraryMeta(token, "badger", libraryReadOpStreamVersion);

/** `/library/db` (the stored copy's pointer) declaring the op stream this build reads. */
export const readLibraryDb = (token: string) => getLibraryDb(token, "badger", libraryReadOpStreamVersion);
