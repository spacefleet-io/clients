import * as sdk from "@space/sdk";
import { ApiError, SPACE_APP_HEADER, unwrap, type ApiErrorPayload, type LibraryMeta, type LibraryPutResult } from "@space/sdk";
import { getApiBaseUrl } from "./apiHost";
import type { TmdbCrewMember } from "@space/shared/api";
import type { SpaceAppId } from "@space/shared/appScope";
import type { StorageObjectCounting } from "@space/shared/storageCounting";
import { clientIdentityHeaders } from "@space/shared/appVersion";
import { OP_STREAM_VERSION } from "@space/library-db-definition/ops";
import { STORAGE_FORMAT_VERSION } from "@space/library-db-definition/storageFormat";
import {
  createUserStorageTunnelClient,
  type StorageDownloadHints,
  type StorageTrafficSnapshot,
  type StorageTunnelPurpose,
} from "@space/shared/storageTunnel";
import { scopeLogger } from "./logger";

export { ApiError };
export type { ApiErrorPayload };

export type { LibraryMeta };

export type TmdbMediaType = "movie" | "tv";

export type TmdbSearchResult = {
  id: number;
  type: TmdbMediaType;
  title: string;
  originalTitle: string | null;
  originalLanguage: string | null;
  overview: string | null;
  year: string | null;
  rating: number | null;
  posterPath: string | null;
  backdropPath: string | null;
};

export type TmdbCastMember = {
  tmdbId: number | null;
  name: string;
  role: string | null;
  profilePath: string | null;
  order: number | null;
};

export type TmdbTrailer = {
  provider: "youtube";
  key: string;
  name: string | null;
  language: string;
  official: boolean;
  size?: number | null;
};

export type TmdbSeason = {
  seasonNumber: number;
  name: string;
  overview: string | null;
  posterPath: string | null;
  episodeCount: number;
  airDate: string | null;
};

export type TmdbEpisode = {
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  overview: string | null;
  stillPath: string | null;
  airDate: string | null;
};

export type TmdbDetails = TmdbSearchResult & {
  cast: TmdbCastMember[];
  /** Crew credits (LIB-CREW-01); absent from older answers. */
  crew?: TmdbCrewMember[];
  trailers: TmdbTrailer[];
  totalEpisodes: number | null;
  seasons: TmdbSeason[];
  episodes: TmdbEpisode[];
  genres: number[];
  /** TMDB `status` of a show ("Returning Series", "Ended", "Canceled", ...); null or absent when unknown. */
  status?: string | null;
  /** TMDB `next_episode_to_air.air_date` (YYYY-MM-DD) of a show; null or absent when none is known. */
  nextEpisodeAirDate?: string | null;
};

const toBinaryBody = (payload: Uint8Array) => Uint8Array.from(payload);
const tunnelLogger = scopeLogger("storage-tunnel-client");

const APP_ID: SpaceAppId = "badger";

/**
 * What every SDK call needs: a client on the API origin as resolved right now (env / custom host),
 * the caller's bearer token (none when empty), and the `x-space-app: badger` scope the API requires per call.
 */
const accountCall = (token: string | null | undefined) => ({
  client: sdk.createSpaceClient({ baseUrl: getApiBaseUrl(), ...(token ? { token } : {}) }),
  headers: { [SPACE_APP_HEADER]: APP_ID },
});

const trafficListeners = new Set<(snapshot: StorageTrafficSnapshot) => void>();

const storageTunnelClient = createUserStorageTunnelClient({
  getApiBaseUrl,
  preferWsDownloadStream: true,
  onDownloadPerf: (event, payload) => {
    if (event !== "download.complete") return;
    const fallbackCount = Number(payload.fallbackCount ?? 0);
    const mode = String(payload.mode ?? "");
    if (fallbackCount > 0 || mode !== "ws-stream") {
      tunnelLogger.warn({ event, ...payload }, "download completed with fallback or non-ws mode");
      return;
    }
    tunnelLogger.debug({ event, ...payload }, "download completed");
  },
  onTrafficChange: (snapshot) => {
    tunnelLogger.info(
      { state: snapshot.state, playbackBufferSeconds: snapshot.playbackBufferSeconds },
      "storage traffic state changed",
    );
    trafficListeners.forEach((listener) => listener(snapshot));
  },
});

/** The gateways' merged high-traffic state (STOR-BW-01); saturation is per silo and arrives through the download hints. */
export const getStorageTraffic = (): StorageTrafficSnapshot => storageTunnelClient.getTraffic();

export const onStorageTrafficChange = (listener: (snapshot: StorageTrafficSnapshot) => void) => {
  trafficListeners.add(listener);
  return () => {
    trafficListeners.delete(listener);
  };
};

export const getLibraryMeta = (token: string) => unwrap(sdk.getLibraryMeta(accountCall(token)));

export const getLibraryDb = (token: string) => unwrap(sdk.getLibraryDb(accountCall(token)));

export const putLibraryOp = (
  token: string,
  baseVersion: number,
  opId: string,
  payload: Uint8Array,
  lineage?: { prevStateHash?: string | null; nextStateHash?: string | null }
) => {
  const scope = accountCall(token);
  return unwrap(
    sdk.postLibraryOp({
      ...scope,
      headers: {
        ...scope.headers,
        "x-library-base-version": String(baseVersion),
        "x-library-op-id": opId,
        ...(lineage?.prevStateHash ? { "x-library-prev-state-hash": lineage.prevStateHash } : {}),
        ...(lineage?.nextStateHash ? { "x-library-next-state-hash": lineage.nextStateHash } : {}),
      },
      // Generated type says Blob|File; `bodySerializer: null` sends the bytes as-is (same call shape as the RN client).
      body: toBinaryBody(payload) as unknown as Blob,
    })
  );
};

export const putLibraryDb = (
  token: string,
  version: number,
  blobBase64: string,
  snapshotId: string,
  chunkSize: number,
  keyProbe?: string | null,
  force?: boolean,
  stateHash?: string | null,
  lastOpId?: string | null
) =>
  unwrap(
    sdk.putLibraryDb({
      ...accountCall(token),
      body: {
        expectedVersion: version,
        manifest: blobBase64,
        manifestEncoding: "base64",
        snapshotId,
        chunkSize,
        chunkRefs: [],
        keyProbe: keyProbe ?? null,
        force: Boolean(force),
        stateHash: stateHash ?? null,
        lastOpId: lastOpId ?? null,
        storageFormatVersion: STORAGE_FORMAT_VERSION,
        opStreamVersion: OP_STREAM_VERSION,
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
  lastOpId?: string | null
) => {
  // Raw fetch, not the SDK: `sdk.putLibraryDb` types its body as the JSON `PutLibraryDbRequest` and
  // always serializes it as JSON, so it cannot carry the raw `application/octet-stream` manifest this
  // fallback sends (the octet-stream variant is only described in prose in the OpenAPI document).
  const res = await fetch(`${getApiBaseUrl()}/library/db`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      [SPACE_APP_HEADER]: APP_ID,
      ...clientIdentityHeaders(),
      "x-library-version": String(version),
      "x-library-snapshot-id": snapshotId,
      "x-library-chunk-size": String(chunkSize),
      "x-library-force": String(Boolean(force)),
      ...(keyProbe ? { "x-library-key-probe": keyProbe } : {}),
      ...(stateHash ? { "x-library-state-hash": stateHash } : {}),
      ...(lastOpId ? { "x-library-last-op-id": lastOpId } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: toBinaryBody(payload),
  });

  if (!res.ok) {
    const errorPayload: ApiErrorPayload = await res.json().catch(() => ({}));
    throw new ApiError(res.status, errorPayload);
  }

  const result: LibraryPutResult = await res.json();
  return result;
};

export const getStoragePlacementPolicy = (token: string) => unwrap(sdk.getStoragePlacement(accountCall(token)));

export const createStorageTunnelSession = async (
  token: string,
  objectKey?: string,
  options?: { purpose?: StorageTunnelPurpose }
) => {
  return storageTunnelClient.createSession(token, objectKey, options);
};

export const sendStorageTunnelFrame = (
  token: string,
  sessionId: string,
  frame: unknown
) => {
  return storageTunnelClient.sendFrame(token, sessionId, frame as Record<string, unknown>);
};

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
    checksumFn?: (chunk: Uint8Array, seq: number) => string | Promise<string>;
    /** Per-media silo placement (#145); set only for media objects. */
    placementId?: string;
    /** How the object counts toward the allowance (STOR-USE-02). */
    counting?: StorageObjectCounting;
  }
) => storageTunnelClient.uploadObject(token, objectKey, payload, options);

export const headStorageObjectsViaApi = (token: string, objectKeys: string[], options?: { signal?: AbortSignal }) =>
  storageTunnelClient.headObjects(token, objectKeys, options);

export const downloadStorageObjectViaTunnel = (
  token: string,
  objectKey: string,
  options?: {
    clientType?: string;
    clientVersion?: string;
    downloadId?: string;
    receiveWindow?: number;
    /** Session purpose (#145): `playback` (default) is refused once the account is unpaid. */
    purpose?: StorageTunnelPurpose;
    /** The profile a playback is for (STOR-BW-11); required for `playback`. */
    profileId?: string | null;
  }
) => storageTunnelClient.downloadObject(token, objectKey, options);

export const downloadStorageObjectViaTunnelToSink = (
  token: string,
  objectKey: string,
  sink: (chunk: Uint8Array) => void | Promise<void>,
  options?: {
    clientType?: string;
    clientVersion?: string;
    downloadId?: string;
    receiveWindow?: number;
    /** Session purpose (#145): `playback` (default) is refused once the account is unpaid. */
    purpose?: StorageTunnelPurpose;
    /** The profile a playback is for (STOR-BW-11); required for `playback`. */
    profileId?: string | null;
    /** Gateway scheduler hints (STOR-BW-01): playing bitrate, start/seek burst, and the silo report callback. */
    hints?: StorageDownloadHints;
  }
) => storageTunnelClient.downloadObjectToSink(token, objectKey, sink, options);

export const listStorageObjects = (token: string) => unwrap(sdk.listStorageObjects(accountCall(token)));

export const deleteStorageObjects = (token: string, keys: string[]) =>
  unwrap(sdk.deleteStorageObjects({ ...accountCall(token), body: { keys } }));
