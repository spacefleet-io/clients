import { DeviceEventEmitter, NativeModules } from "react-native";
import type { ChunkedFile, MediaProxyStartArgs, StartProxyArgs, StartProxyConfig } from "./types";

type PlaybackBridgeNative = {
  startProxy: (
    metadataJson: string,
    libraryKeyBase64: string,
    config: StartProxyConfig,
  ) => Promise<string>;
  start: (libraryKeyBase64: string, config: StartProxyConfig) => Promise<string>;
  registerChunkedFile: (fileJson: string) => Promise<string>;
  swapChunkedFile: (fileJson: string) => Promise<boolean>;
  unregisterChunkedFile: (id: string) => Promise<boolean>;
  stopProxy: () => Promise<boolean>;
  setBufferCap: (seconds: number) => Promise<boolean>;
  /** Android only (iOS has no make-before-break switch yet). */
  warmRung?: (variantId: string, atSeconds: number) => Promise<boolean>;
};

const native: PlaybackBridgeNative = NativeModules.PlaybackBridge ?? new Proxy(
  {} as PlaybackBridgeNative,
  {
    get(_, prop) {
      return () => {
        throw new Error(
          `PlaybackBridge.${String(prop)} called but the native module is not available. ` +
          `Ensure @space/mobile-media-proxy is autolinked (a direct dependency of the app).`
        );
      };
    },
  }
);

/**
 * Device event of the native playback proxy: what the storage gateway said about traffic (STOR-BW-07, STOR-BW-08). One JSON string
 * (Android) or dictionary (iOS) `{ source: "session" | "ack" | "download", status, code, traffic }`: the HTTP status, the body's
 * `error` (`free_playback_refused`, `playback_stopped`) and its `traffic` object, forwarded as the gateway sent them.
 */
export const PLAYBACK_TRAFFIC_EVENT = "SpacePlaybackTraffic";

/**
 * Device event of the native playback proxy: one object the player's fetches downloaded through the gateway, `{ bytes, ms }`
 * (its encrypted size and how long it took, request included). Objects read from the phone's disk send nothing.
 */
export const PLAYBACK_DOWNLOAD_EVENT = "SpacePlaybackDownload";

export type PlaybackDownload = { bytes: number; ms: number };

/**
 * Bridge to the native HLS proxy. The full playback hot path runs in
 * Kotlin: HTTP server, OkHttp tunnel client, AES-256-GCM decrypt, HLS
 * playlist generation.
 *
 * Lifecycle:
 *
 *   const url = await PlaybackBridge.startProxy({
 *     metadataJson: JSON.stringify(metadata),
 *     libraryKeyBase64: cachedMasterKey,
 *     config: {
 *       clientKind: "storage-tunnel",
 *       gatewayBaseUrl: getStorageGatewayBaseUrl(),
 *       authToken,
 *       appId: "badger",
 *       profileId: activeProfile.id,
 *     },
 *   });
 *   // <MpvPlayer source={url} />
 *
 *   // on unmount:
 *   await PlaybackBridge.stopProxy();
 *
 * Idempotent: a second startProxy call against an already-running server
 * just creates a new HLS session on the same port and returns the new URL.
 */
export const PlaybackBridge = {
  /**
   * Start (or reuse) the native HLS proxy and create an HLS session for
   * the supplied metadata. Returns the master.m3u8 URL ready to feed to
   * `<MpvPlayer source={url} />`.
   */
  startProxy: ({ metadataJson, libraryKeyBase64, config }: StartProxyArgs): Promise<string> => {
    // STOR-BW-11: a streaming session always names its profile; the gateway refuses one without (400 profile_required).
    if (config.clientKind === "storage-tunnel" && !config.profileId) {
      console.warn("playback.bridge.profile_required", JSON.stringify({ clientKind: config.clientKind }));
      return Promise.reject(new Error("profile_required"));
    }
    return native.startProxy(metadataJson, libraryKeyBase64, config);
  },

  /** Tear the server down. Best-effort. */
  stopProxy: (): Promise<boolean> => native.stopProxy(),

  /**
   * High-traffic playback buffer (STOR-BW-01): shrink the proxy's segment look-ahead and mpv's cache to `seconds`
   * (the silo's `playbackBufferSeconds`); 0 restores the normal look-ahead. Best-effort and idempotent.
   */
  setBufferCap: (seconds: number): Promise<boolean> => native.setBufferCap(seconds),

  /**
   * Make-before-break rung switch (PLAY-ABR-04): resolves once the rung `variantId`'s segment at `atSeconds` (with its
   * init and the audio there) is fetched, while the player plays on; from the call on the proxy stops the other rungs'
   * downloads and read-ahead, so the segment gets the whole link. Null where the native proxy has no such switch (iOS):
   * the caller then reloads straight away.
   */
  warmRung: (): ((variantId: string, atSeconds: number) => Promise<boolean>) | null => {
    const warm = (NativeModules.PlaybackBridge as Partial<PlaybackBridgeNative> | undefined)?.warmRung;
    return typeof warm === "function" ? (variantId, atSeconds) => warm(variantId, atSeconds) : null;
  },

  /** Subscribes to the gateway's traffic answers heard by the proxy; returns the unsubscribe function. */
  onTraffic: (handler: (event: unknown) => void): (() => void) => {
    const subscription = DeviceEventEmitter.addListener(PLAYBACK_TRAFFIC_EVENT, handler);
    return () => subscription.remove();
  },
};

/**
 * The proxy without HLS: a player that reads a plain file (Parrot's Media3 ExoPlayer) starts the server, registers each
 * chunked file it wants to play and hands the player the returned URL. Android only for now.
 *
 *   const base = await MediaProxy.start({ libraryKeyBase64, config: { clientKind: "storage-tunnel", gatewayBaseUrls,
 *     authToken, appId: "parrot", profileId } });
 *   const url = await MediaProxy.registerChunkedFile({ id, mime, sizeBytes, chunks });
 *   // player.setMediaItem(MediaItem.fromUri(url)): `Range:` requests fetch and decrypt only the 1 MiB chunks they cover.
 *
 * The server is process-wide (not tied to a screen) and is shared with `PlaybackBridge.startProxy`: the same key and config
 * reuse it; another config (a refreshed token included) rebuilds it on a new port, and every file must then be registered
 * again on the new base URL.
 */
export const MediaProxy = {
  /** Starts (or reuses) the proxy; resolves with its base URL `http://127.0.0.1:<port>`. Rejects `profile_required` like `startProxy`. */
  start: ({ libraryKeyBase64, config }: MediaProxyStartArgs): Promise<string> => {
    if (config.clientKind === "storage-tunnel" && !config.profileId) {
      console.warn("media_proxy.start.profile_required", JSON.stringify({ clientKind: config.clientKind }));
      return Promise.reject(new Error("profile_required"));
    }
    return native.start(libraryKeyBase64, config);
  },

  /** Serves `file` at `<base>/playback/chunked/<id>`; resolves with that URL. Rejects `proxy_not_started` before `start`. */
  registerChunkedFile: (file: ChunkedFile): Promise<string> => native.registerChunkedFile(JSON.stringify(file)),

  /** Forgets a registered file; resolves false when it was not registered. */
  unregisterChunkedFile: (id: string): Promise<boolean> => native.unregisterChunkedFile(id),

  /**
   * Serves `file` at its already registered `file.id` instead, unless the player already asked for that id (a song never
   * changes copy midway, PAR-PLAY-04). Resolves true when swapped.
   */
  swapChunkedFile: (file: ChunkedFile): Promise<boolean> => native.swapChunkedFile(JSON.stringify(file)),

  /** Subscribes to each object downloaded for the player (`PLAYBACK_DOWNLOAD_EVENT`); returns the unsubscribe function. */
  onDownload: (handler: (event: PlaybackDownload) => void): (() => void) => {
    const subscription = DeviceEventEmitter.addListener(PLAYBACK_DOWNLOAD_EVENT, handler);
    return () => subscription.remove();
  },

  /** Tears the server down (the same server `PlaybackBridge.startProxy` uses). */
  stop: (): Promise<boolean> => native.stopProxy(),

  onTraffic: PlaybackBridge.onTraffic,
};
