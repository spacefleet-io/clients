/// <reference path="./reactNativeTv.d.ts" />
// @space/mobile-mpv-playback — public surface.
//
// libmpv player for SpaceBadger React Native clients (Android and iOS). It plays
// the HLS sessions of the loopback decrypt proxy, which lives in
// @space/mobile-media-proxy on Android (re-exported here for the player's
// callers) and still ships in this package's pod on iOS.

export {
  AirPlayPlayer,
  AirPlayRoutePickerView,
  type AirPlayRoute,
  type AirPlayRoutePickerProps,
  type AirPlayState,
  type AirPlayStatus,
} from "./AirPlayPlayer";
export { CastServer, type CastServerInfo } from "./CastServer";
export { MpvPlayer, type MpvPlayerProps, type MpvSurfaceTapEvent } from "./components/MpvPlayer";
export {
  PlayerControls,
  type PlayerControlsHandle,
  type PlayerControlsLabels,
  type PlayerControlsProps,
  type PlayerControlsTheme,
} from "./components/PlayerControls";
export { useMpvPlaybackState } from "./hooks/useMpvPlaybackState";
export { MpvControl } from "./MpvControl";
export { switchEpisodeKeepingCore } from "./backgroundSource";
export { PlaybackBridge, type StartProxyArgs, type StartProxyConfig } from "@space/mobile-media-proxy";
export type {
  AudioTrack,
  Chapter,
  CodecCaps,
  DecoderCaps,
  DecoderLimits,
  DecoderProbe,
  IngestMetadata,
  MpvTrack,
  PlaybackSnapshot,
  PlaybackState,
  ProbeResult,
  SeekMode,
  SubtitleTrack,
  VideoChunk,
  VideoFormat,
} from "./types";
