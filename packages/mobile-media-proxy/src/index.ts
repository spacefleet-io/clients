// @space/mobile-media-proxy: the native loopback decrypt proxy (Android, Kotlin). It serves the user's encrypted storage
// objects decrypted on 127.0.0.1: HLS sessions for Badger's mpv player (`PlaybackBridge.startProxy`) and plain byte-range
// files stored as 1 MiB SFV1 chunks for Parrot's ExoPlayer (`MediaProxy.registerChunkedFile`, PAR-FMT-01).

export { MediaProxy, PLAYBACK_DOWNLOAD_EVENT, PLAYBACK_TRAFFIC_EVENT, PlaybackBridge, type PlaybackDownload } from "./PlaybackBridge";
export { resolveGatewayCandidates } from "./playbackGateway";
export type {
  ChunkedFile,
  ChunkedFileChunk,
  MediaProxyStartArgs,
  StartProxyArgs,
  StartProxyConfig,
} from "./types";
