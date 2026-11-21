import * as sdk from "@space/sdk";
import { unwrap, type Client } from "@space/sdk";
import { SPACE_APP_HEADER, type SpaceAppId } from "./appScope";

/**
 * The library storage and op-stream formats a client declares on every write.
 * The caller supplies the values (`STORAGE_FORMAT_VERSION`, and `writeOpStreamVersion(target)` for Badger,
 * from `@space/library-db-definition`): shared cannot import the definition
 * package without a dependency cycle. The server rejects a write that declares
 * less than the library's stored version (LIB-FMT-05 downgrade protection).
 */
export type LibraryWriterFormats = { storageFormatVersion: number; opStreamVersion: number };

export type LibraryOpLineage = { prevStateHash?: string | null; nextStateHash?: string | null };

export type LibraryOpUploadResult = { version: number; snapshotVersion: number; stateHash: string | null; lastOpId: string | null };

/**
 * The one upload of an encrypted library op (POST /library/db/ops), shared by every client: the web/phone transport
 * (`@space/shared/api` `putLibraryOp`) and the desktop/server runtime (`@space/library-db-runtime`). Vault v4 audit:
 * three copies had drifted, one declaring no formats at all. `call` is the caller's client, auth and scope headers.
 */
export const postLibraryOp = (
  call: { client: Client; auth?: string; headers: { [SPACE_APP_HEADER]: SpaceAppId } },
  baseVersion: number,
  opId: string,
  payload: Uint8Array,
  lineage: LibraryOpLineage | undefined,
  formats: LibraryWriterFormats | undefined
): Promise<LibraryOpUploadResult> =>
  unwrap(
    sdk.postLibraryOp({
      ...call,
      headers: {
        ...call.headers,
        "x-library-base-version": String(baseVersion),
        "x-library-op-id": opId,
        ...(lineage?.prevStateHash ? { "x-library-prev-state-hash": lineage.prevStateHash } : {}),
        ...(lineage?.nextStateHash ? { "x-library-next-state-hash": lineage.nextStateHash } : {}),
        ...(formats
          ? {
              "x-library-storage-format-version": String(formats.storageFormatVersion),
              "x-library-op-stream-version": String(formats.opStreamVersion),
            }
          : {}),
      },
      // The generated type says Blob|File, but `bodySerializer: null` hands the bytes to fetch as-is, and
      // `new Blob([typedArray])` throws on React Native; so pass the Uint8Array and cast.
      body: Uint8Array.from(payload) as unknown as Blob,
    })
  ) as Promise<LibraryOpUploadResult>;
