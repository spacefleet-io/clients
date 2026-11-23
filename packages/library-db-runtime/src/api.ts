import * as sdk from "@space/sdk";
import { ApiError, SPACE_APP_HEADER, unwrap, type ApiErrorPayload, type LibraryMeta, type LibraryPutResult } from "@space/sdk";
import { getApiBaseUrl } from "./apiHost";
import {
  createUserStorageTunnelClient,
  type StorageTunnelPurpose,
  type StorageUploadSession,
  type UserStorageTunnelClient,
} from "@space/shared/storageTunnel";
import { DEFAULT_SPACE_APP_ID, type SpaceAppId } from "@space/shared/appScope";
import { clientIdentityHeaders } from "@space/shared/appVersion";
import type { StorageObjectCounting } from "@space/shared/storageCounting";
import { parseLibraryOpsResponse, type ChunkRefsSource, type LibraryOpsResponse } from "@space/shared/contracts/library";
import { STORAGE_FORMAT_VERSION } from "@space/library-db-definition/storageFormat";
import { scopeLogger } from "./logger";

export { ApiError };
export type { ApiErrorPayload, LibraryMeta };
export type { StorageUploadSession };

export type { CastMember, Trailer, TitleDetails, TitleEpisode, TitleSearchResult, TitleSeason, TitleType } from "@space/shared/api";

export type StorageTunnelSession = {
  sessionId: string;
  protocolVersion: 1;
  createdAt: number;
  expiresAt: number;
  gatewayUrl?: string;
  shardId?: string;
  placementEpoch?: number;
  resolvedObjectKey?: string | null;
  objectKeyPrefix?: string;
  features: {
    upload: boolean;
    download: boolean;
  };
};

export type StorageTunnelFrame = Record<string, unknown>;

const toBinaryBody = (payload: Uint8Array) => Uint8Array.from(payload);

/**
 * What every SDK call needs: a client on the API origin as resolved right now (env / custom host),
 * the caller's bearer token (none when empty), and the `x-space-app` scope the API requires per call.
 */
const accountCall = (token: string | null | undefined, appId: SpaceAppId) => ({
  client: sdk.createSpaceClient({ baseUrl: getApiBaseUrl(), ...(token ? { token } : {}) }),
  headers: { [SPACE_APP_HEADER]: appId },
});

const tunnelLogger = scopeLogger("storage-tunnel");
let tunnelMode: "direct" | "waterfall" | undefined;
/** One tunnel client per app: the client sends its app's `x-space-app` on every session (Badger's and Parrot's libraries share the transport, never the scope). */
const storageTunnelClients = new Map<SpaceAppId, UserStorageTunnelClient>();
const tunnelClientFor = (appId: SpaceAppId) => {
  let client = storageTunnelClients.get(appId);
  if (!client) {
    client = createUserStorageTunnelClient({
      getApiBaseUrl,
      getAppId: () => appId,
      ...(tunnelMode ? { tunnelMode } : {}),
      log: (event, payload) => tunnelLogger.debug(payload, event),
    });
    storageTunnelClients.set(appId, client);
  }
  return client;
};

/**
 * Hosts that cannot reach the loopback `gatewayUrl` (Jellyfin/Kodi servers) pick "waterfall":
 * every shard address is tried, then `gatewayUrl`; when all fail, the last error is thrown (never an API fallback).
 */
export const setLibraryTunnelMode = (mode: "direct" | "waterfall") => {
  tunnelMode = mode;
  storageTunnelClients.clear();
};

export const getLibraryMeta = (token: string, appId: SpaceAppId = DEFAULT_SPACE_APP_ID) =>
  unwrap(sdk.getLibraryMeta(accountCall(token, appId)));

export const getLibraryDb = (token: string, appId: SpaceAppId = DEFAULT_SPACE_APP_ID) =>
  unwrap(sdk.getLibraryDb(accountCall(token, appId)));

export const getLibraryOps = async (
  token: string,
  sinceVersion: number,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID
): Promise<LibraryOpsResponse> => {
  const raw = await unwrap(
    sdk.getLibraryOps({ ...accountCall(token, appId), query: { since: String(sinceVersion) } })
  );
  return parseLibraryOpsResponse(raw);
};

export const putLibraryOp = (
  token: string,
  baseVersion: number,
  opId: string,
  payload: Uint8Array,
  lineage?: { prevStateHash?: string | null; nextStateHash?: string | null },
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID
) => {
  const scope = accountCall(token, appId);
  return unwrap(
    sdk.postLibraryOp({
      ...scope,
      headers: {
        ...scope.headers,
        "x-library-base-version": String(baseVersion),
        "x-library-op-id": opId,
        "x-library-storage-format-version": String(STORAGE_FORMAT_VERSION),
        ...(lineage?.prevStateHash ? { "x-library-prev-state-hash": lineage.prevStateHash } : {}),
        ...(lineage?.nextStateHash ? { "x-library-next-state-hash": lineage.nextStateHash } : {}),
      },
      // Generated type says Blob|File; `bodySerializer: null` sends the bytes as-is (same call shape as the RN client).
      body: toBinaryBody(payload) as unknown as Blob,
    })
  );
};

/**
 * Send a snapshot PUT to /library/db. JSON-body contract: chunkRefs is mandatory and carried in the
 * body, eliminating the legacy 6KB header cap.
 */
export const putLibraryDb = (
  token: string,
  version: number,
  blobBase64: string,
  snapshotId: string,
  chunkSize: number,
  keyProbe: string | null | undefined,
  force: boolean | undefined,
  stateHash: string | null | undefined,
  lastOpId: string | null | undefined,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID,
  chunkRefs: string[] | undefined,
  // Pass only when chunkRefs is exactly the published manifest's chunk set
  // (see TRUSTED_CHUNK_REFS_VERSION); undefined = the orphan sweep keeps the
  // user's stored chunks.
  chunkRefsSource: ChunkRefsSource | undefined,
  // The publishing app's own change-type version (LIB-FMT-09): Badger's
  // `OP_STREAM_VERSION`, Parrot's `PARROT_OP_STREAM_VERSION`. This transport is
  // shared by both apps, so it cannot know which vocabulary the snapshot holds.
  opStreamVersion: number
) =>
  unwrap(
    sdk.putLibraryDb({
      ...accountCall(token, appId),
      body: {
        expectedVersion: version,
        manifest: blobBase64,
        manifestEncoding: "base64",
        snapshotId,
        chunkSize,
        chunkRefs: Array.isArray(chunkRefs) ? chunkRefs : [],
        ...(chunkRefsSource ? { chunkRefsSource } : {}),
        keyProbe: keyProbe ?? null,
        force: Boolean(force),
        stateHash: stateHash ?? null,
        lastOpId: lastOpId ?? null,
        // Declare the formats this snapshot is written in, so the API's
        // downgrade protection (LIB-FMT-05) sees a truthful declaration: the
        // storage format is this transport's own, the op-stream version the
        // publishing app's.
        storageFormatVersion: STORAGE_FORMAT_VERSION,
        opStreamVersion,
      },
    })
  );

export const putLibraryDbBinary = async (
  token: string,
  version: number,
  payload: Uint8Array,
  snapshotId: string,
  chunkSize: number,
  keyProbe?: string | null,
  force?: boolean,
  stateHash?: string | null,
  lastOpId?: string | null,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID,
  chunkRefs?: string[]
) => {
  // Emergency fallback only — new code should call putLibraryDb (JSON body).
  const chunkRefsHeader = Array.isArray(chunkRefs) && chunkRefs.length > 0
    ? JSON.stringify(chunkRefs)
    : undefined;
  // Raw fetch, not the SDK: `sdk.putLibraryDb` types its body as the JSON `PutLibraryDbRequest` and
  // always serializes it as JSON, so it cannot carry the raw `application/octet-stream` manifest this
  // emergency fallback sends (the octet-stream variant is only described in prose in the OpenAPI document).
  const res = await fetch(`${getApiBaseUrl()}/library/db`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      [SPACE_APP_HEADER]: appId,
      ...clientIdentityHeaders(),
      "x-library-version": String(version),
      "x-library-snapshot-id": snapshotId,
      "x-library-chunk-size": String(chunkSize),
      "x-library-force": String(Boolean(force)),
      ...(keyProbe ? { "x-library-key-probe": keyProbe } : {}),
      ...(stateHash ? { "x-library-state-hash": stateHash } : {}),
      ...(lastOpId ? { "x-library-last-op-id": lastOpId } : {}),
      ...(chunkRefsHeader ? { "x-library-chunk-refs": chunkRefsHeader } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: toBinaryBody(payload),
  });

  if (!res.ok) {
    const errorPayload = (await res.json().catch(() => ({}))) as ApiErrorPayload;
    throw new ApiError(res.status, errorPayload);
  }

  const result = (await res.json()) as LibraryPutResult;
  return result;
};

export const createStorageTunnelSession = (token: string, objectKey?: string, appId: SpaceAppId = DEFAULT_SPACE_APP_ID) =>
  tunnelClientFor(appId).createSession(token, objectKey);

export const sendStorageTunnelFrame = (
  token: string,
  sessionId: string,
  frame: StorageTunnelFrame,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID
) =>
  tunnelClientFor(appId).sendFrame(token, sessionId, frame as Record<string, unknown>);

export const uploadStorageObjectViaTunnel = (
  token: string,
  objectKey: string,
  payload: Uint8Array,
  options?: {
    objectNamespace?: string;
    logicalRef?: string;
    contentType?: string;
    chunkSize?: number;
    clientType?: string;
    clientVersion?: string;
    uploadId?: string;
    checksumFn?: (chunk: Uint8Array, seq: number) => string;
    /** Per-media silo (#145): the object is stored under media/<placementId>/ and the placed key is returned. */
    placementId?: string;
    /** How the object counts toward the allowance (STOR-USE-02). */
    counting?: StorageObjectCounting;
  },
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID
) =>
  tunnelClientFor(appId).uploadObject(token, objectKey, payload, options);

/** One reused upload session for many objects of one media placement (STOR-REUSE-01). */
export const openStorageUploadSession = (
  token: string,
  session: { placementId: string; clientType?: string; clientVersion?: string },
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID
): StorageUploadSession => tunnelClientFor(appId).createUploadSession(token, session);

export const downloadStorageObjectViaTunnel = (
  token: string,
  objectKey: string,
  options?: {
    clientType?: string;
    clientVersion?: string;
    downloadId?: string;
    /** Session purpose (#145): `export` and `library` stay allowed once the account is unpaid. */
    purpose?: StorageTunnelPurpose;
    /** The profile a playback download is for (STOR-BW-11). */
    profileId?: string | null;
  },
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID
) =>
  tunnelClientFor(appId).downloadObject(token, objectKey, options);

export const listStorageObjects = (token: string, appId: SpaceAppId = DEFAULT_SPACE_APP_ID) =>
  unwrap(sdk.listStorageObjects(accountCall(token, appId)));

export const deleteStorageObjects = (token: string, keys: string[], appId: SpaceAppId = DEFAULT_SPACE_APP_ID) =>
  unwrap(sdk.deleteStorageObjects({ ...accountCall(token, appId), body: { keys } }));
