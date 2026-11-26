import * as sdk from "@space/sdk";
import { ApiError, SPACE_APP_HEADER, unwrap, type ApiErrorPayload } from "@space/sdk";
import { getApiBaseUrl } from "./apiHost";
import type { SpaceAppId } from "@space/shared/appScope";
import type { FeedbackInput } from "@space/shared/api";
import type { StorageObjectCounting } from "@space/shared/storageCounting";
import {
  createUserStorageTunnelClient,
  type StorageDownloadHints,
  type StorageTrafficSnapshot,
  type StorageTunnelPurpose,
} from "@space/shared/storageTunnel";
import { scopeLogger } from "./logger";

export { ApiError };
export type { ApiErrorPayload };

export type {
  CastMember,
  TitleDetails,
  TitleEpisode,
  TitleSearchResult,
  TitleSeason,
  TitleType,
  Trailer,
} from "@space/shared/api";

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

/** UX-SUP-05: Settings > Help & feedback, sent by main with the window's session (`feedbackIpc.ts`). */
export const sendFeedback = (token: string, body: FeedbackInput) => unwrap(sdk.sendFeedback({ ...accountCall(token), body }));

// ACCT-PAIR-07: approving Parrot's sign-in on this computer (the local channel, `@space/desktop-shell/sibling-main`).
export const lookupPairing = (token: string, code: string) => unwrap(sdk.lookupPairing({ ...accountCall(token), query: { code } }));

/** `{ localKey: true }`: the library key goes to Parrot over the local channel, never to the API. */
export const approvePairingLocal = (token: string, requestId: string) =>
  unwrap(sdk.approvePairing({ ...accountCall(token), path: { requestId }, body: { localKey: true } }));

export const denyPairing = (token: string, requestId: string) => unwrap(sdk.denyPairing({ ...accountCall(token), path: { requestId } }));
