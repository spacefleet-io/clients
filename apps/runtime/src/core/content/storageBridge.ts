import {
  createUserStorageTunnelClient,
  type StorageTunnelPurpose,
  type StorageTunnelSession,
  type TunnelClientFrame,
  type TunnelGatewayFrame,
} from "@space/shared/storageTunnel";
import type { StorageObjectCounting } from "@space/shared/storageCounting";

export type RuntimeContentStorageApp = "badger" | "parrot";

export const resolveRuntimeContentApiBaseUrl = () =>
  String(
    process.env.SPACEFLEET_API_BASE_URL ?? process.env.API_BASE_URL ?? process.env.SF_API_BASE_URL ?? "http://127.0.0.1:3000"
  )
    .trim()
    .replace(/\/+$/, "");

export const createRuntimeContentStorageBridge = (appId: RuntimeContentStorageApp) => {
  const client = createUserStorageTunnelClient({
    getApiBaseUrl: resolveRuntimeContentApiBaseUrl,
    getAppId: () => appId,
  });

  return {
    uploadObject: (token: string, objectKey: string, payload: Uint8Array, options?: Parameters<typeof client.uploadObject>[3]) =>
      client.uploadObject(token, objectKey, payload, options),
    downloadObject: (token: string, objectKey: string, options?: Parameters<typeof client.downloadObject>[2]) =>
      client.downloadObject(token, objectKey, options),
    createSession: (token: string, objectKey?: string): Promise<StorageTunnelSession> => client.createSession(token, objectKey),
    sendFrame: (token: string, sessionId: string, frame: TunnelClientFrame): Promise<TunnelGatewayFrame> =>
      client.sendFrame(token, sessionId, frame),
    headObjects: (token: string, objectKeys: string[], options?: { signal?: AbortSignal }) =>
      client.headObjects(token, objectKeys, options),
    /**
     * Traffic reads: `current` is the merged "any silo high" snapshot (STOR-BW-01, no network call); `refresh` is the
     * report of the silo serving `objectKey` (STOR-BW-07..09), via `GET /storage/traffic`; null when unknown.
     */
    traffic: {
      current: () => client.getTraffic(),
      refresh: (token: string, objectKey: string) => client.refreshTraffic(token, objectKey),
    },
  };
};

export const createRuntimeContentUploadAdapter = (
  bridge: ReturnType<typeof createRuntimeContentStorageBridge>,
  token: string
) => {
  return async (args: {
    objectKey: string;
    payload: Uint8Array;
    objectNamespace: string;
    logicalRef: string;
    contentType: string;
    /** How the object counts toward the allowance (STOR-USE-02). */
    counting?: StorageObjectCounting;
  }) => {
    const uploadedObjectKey = await bridge.uploadObject(token, args.objectKey, args.payload, {
      objectNamespace: args.objectNamespace,
      logicalRef: args.logicalRef,
      contentType: args.contentType,
      ...(args.counting ? { counting: args.counting } : {}),
    });
    return {
      objectKey: uploadedObjectKey,
      sizeBytes: args.payload.byteLength,
    };
  };
};

/**
 * Download adapter bound to a tunnel session `purpose`: an unpaid account is refused `playback` (402
 * `subscription_unpaid`) but may still `export` its own files, so callers must say which one they are.
 */
export const createRuntimeContentDownloadAdapter = (
  bridge: ReturnType<typeof createRuntimeContentStorageBridge>,
  token: string,
  purpose: StorageTunnelPurpose
) => {
  return async (objectKey: string, downloadId?: string) =>
    bridge.downloadObject(token, objectKey, { ...(downloadId ? { downloadId } : {}), purpose });
};

export const createRuntimeMediaStorageTransport = (
  bridge: ReturnType<typeof createRuntimeContentStorageBridge>
) => {
  return {
    uploadStorageObject: (
      token: string,
      objectKey: string,
      payload: Uint8Array,
      options?: Parameters<typeof bridge.uploadObject>[3]
    ) => bridge.uploadObject(token, objectKey, payload, options),
    headStorageObjects: (token: string, objectKeys: string[], options?: { signal?: AbortSignal }) =>
      bridge.headObjects(token, objectKeys, options),
  };
};
