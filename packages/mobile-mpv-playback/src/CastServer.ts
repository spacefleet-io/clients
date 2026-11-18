import { DeviceEventEmitter, NativeModules } from "react-native";
import type { StartProxyConfig } from "@space/mobile-media-proxy";

/** What `CastServer.start` returns. All URLs carry the one-time token under `/cast/<token>/`. */
export type CastServerInfo = {
  /** `http://<wifi-ip>:<port>/cast/<token>`: prefix of every URL the cast target may fetch. */
  baseUrl: string;
  /** `<baseUrl>/playback/hls/<sessionId>/master.m3u8`: the stream to hand to the cast target. */
  masterUrl: string;
  /** The phone's Wi-Fi IPv4 address the URLs use. */
  host: string;
  port: number;
};

/**
 * Device event of the native cast server: what the storage gateway said about traffic (STOR-BW-07, STOR-BW-08), in the shape
 * `PLAYBACK_TRAFFIC_EVENT` carries (a JSON string on Android, a dictionary on iOS). Its own event, so the player's listener never
 * hears a cast and the cast screen never hears the player.
 */
export const CAST_TRAFFIC_EVENT = "SpaceCastTraffic";

type CastServerNative = {
  /** `config.castStartSeconds`: where the cast starts, so the server warms the segments from there (Android). */
  start: (metadataJson: string, libraryKeyBase64: string, config: StartProxyConfig & { castStartSeconds?: number }, token: string) => Promise<CastServerInfo>;
  readText: (key: string) => Promise<string>;
  putText: (key: string, body: string) => Promise<boolean>;
  stop: () => Promise<boolean>;
};

const native: CastServerNative =
  NativeModules.CastServer ??
  new Proxy({} as CastServerNative, {
    get(_, prop) {
      return () => {
        throw new Error(
          `CastServer.${String(prop)} called but the native module is not available. ` +
            `Ensure @space/mobile-mpv-playback is autolinked (Android and iOS).`,
        );
      };
    },
  });

/**
 * Bridge to the native LAN server that feeds a cast target (UX-TV-03). It is a second instance of the playback proxy: same
 * storage tunnel, same AES-GCM decrypt, same HLS playlists, but it listens on the phone's Wi-Fi address instead of
 * loopback and answers only under the one-time `/cast/<token>/` path.
 *
 *   const info = await CastServer.start({ metadataJson, libraryKeyBase64, config, token });
 *   // hand info.masterUrl to the Cast receiver / AVPlayer
 *   await CastServer.stop();
 *
 * `metadataJson` is already trimmed by the caller (one video version, the playable audio, the chosen subtitle): the server
 * serves exactly the keys it names, plus any text registered with `putText`.
 */
export const CastServer = {
  /** `startSeconds`: where the device will start playing (a resume point), so the first segments are warm by then. */
  start: (args: { metadataJson: string; libraryKeyBase64: string; config: StartProxyConfig; token: string; startSeconds?: number }): Promise<CastServerInfo> =>
    native.start(args.metadataJson, args.libraryKeyBase64, { ...args.config, castStartSeconds: args.startSeconds ?? 0 }, args.token),

  /** The decrypted text of a stored object (a subtitle file), so JS can convert it to WebVTT. */
  readText: (key: string): Promise<string> => native.readText(key),

  /** Serve `body` for `/playback/object/<key>` (as `text/vtt`) instead of the stored bytes. */
  putText: (key: string, body: string): Promise<boolean> => native.putText(key, body),

  /** Stop the server and drop the token. Idempotent. */
  stop: (): Promise<boolean> => native.stop(),

  /** Subscribes to the gateway's traffic answers heard by the cast server; returns the unsubscribe function. */
  onTraffic: (handler: (event: unknown) => void): (() => void) => {
    const subscription = DeviceEventEmitter.addListener(CAST_TRAFFIC_EVENT, handler);
    return () => subscription.remove();
  },
};
