import { NativeModules } from "react-native";
import type { TvAudioReport } from "./tvAudioOutput";
import { composeIosDecoderCaps, describeIosProfile, iosDecoderProfile, type IosDecoderReport } from "./iosDecoderCaps";
import { withSidecarWarmup } from "./sidecarWarmup";
import type { DecoderCaps, DecoderProbe, MpvTrack, PlaybackSnapshot, PlaybackState, SeekMode } from "./types";

type MpvControlNative = {
  togglePause: () => Promise<boolean>;
  setPaused: (paused: boolean) => Promise<boolean>;
  seek: (seconds: number, mode: SeekMode | null) => Promise<boolean>;
  seekRelative: (seconds: number, mode: SeekMode | null) => Promise<boolean>;
  seekToTime: (url: string, seconds: number) => Promise<boolean>;
  loadFromUrl: (url: string) => Promise<boolean>;
  getPlaybackState: () => Promise<PlaybackState>;
  getPlaybackSnapshot: () => Promise<PlaybackSnapshot>;
  loadAt: (url: string, startSeconds: number, options: string | null) => Promise<boolean>;
  /**
   * Android only: loads a new `source` into the live player view now, while the app is in the background (React Native
   * holds view props until the window shows again). See `backgroundSource.ts`.
   */
  loadInBackground?: (url: string, options: string | null) => Promise<boolean>;
  /** Android only: an episode switch is next; with the app hidden the old player's core plays on. See `backgroundSource.ts`. */
  holdCoreForSwitch?: () => Promise<boolean>;
  setHwdec: (value: string) => Promise<boolean>;
  setKeepScreenOn: (enabled: boolean) => Promise<boolean>;
  setVolume: (volume: number) => Promise<boolean>;
  /** Host window brightness, 0..1 (the window override, else the system level). */
  getScreenBrightness: () => Promise<number>;
  /** Overrides host window brightness (0..1); a negative level restores the system brightness. */
  setScreenBrightness: (level: number) => Promise<boolean>;
  setVideoTrack: (id: number) => Promise<boolean>;
  setAudioTrack: (id: number) => Promise<boolean>;
  setSubtitleTrack: (id: number) => Promise<boolean>;
  setSecondarySubtitleTrack: (id: number) => Promise<boolean>;
  getTimePos: () => Promise<number>;
  setSubDelay: (seconds: number) => Promise<boolean>;
  /** mpv `sub-pos`: where the bottom subtitle line ends, % of the picture height (100 = mpv's default place). */
  getSubPos: () => Promise<number>;
  setSubPos: (value: number) => Promise<boolean>;
  addSubtitle: (url: string, language: string | null, title: string | null) => Promise<boolean>;
  removeAllSubtitles: () => Promise<boolean>;
  /** The phone's real decoder capabilities, plus whether it decodes each probe (size@fps, bit depth) in hardware / software. */
  getDecoderCaps: (probes: DecoderProbe[]) => Promise<DecoderCaps>;
  getTrackList: () => Promise<MpvTrack[]>;
  setImmersiveLandscape: (enabled: boolean) => Promise<boolean>;
  /** What the box reports about its audio sink (TV audio output, MPV-TV-03); planned in JS by `planTvAudioOutput`. */
  getAudioOutputReport: () => Promise<TvAudioReport>;
  /** Applies a TV audio plan (mpv `audio-spdif` / `audio-channels`, tvOS session channels); kept for the next core too. */
  setAudioOutput: (spdif: string, channels: string, preferredOutputChannels: number, reason: string) => Promise<boolean>;
};

/** The iOS native module has no `getDecoderCaps`: it reports raw facts, the limits are composed in JS (`iosDecoderCaps.ts`). */
type MpvControlIosNative = MpvControlNative & {
  getDeviceDecoderReport?: () => Promise<IosDecoderReport>;
};

type DecoderCapsReader = Pick<MpvControlNative, "getDecoderCaps">;

/**
 * iPhone: `getDecoderCaps` is answered from Apple's published limits for the model (PLAY-QUAL-06), in the same shape
 * Android's `MediaCodecList` read has, from `report` (the native `getDeviceDecoderReport`). Every other method of
 * `native` is left as it is.
 */
export const withIosDecoderCaps = <T extends object>(native: T, report: () => Promise<IosDecoderReport>): T & DecoderCapsReader => {
  const getDecoderCaps = async (probes: DecoderProbe[]): Promise<DecoderCaps> => {
    const raw = await report();
    const caps = composeIosDecoderCaps(raw, probes);
    console.info(`[iosDecoderCaps] ${describeIosProfile(iosDecoderProfile(raw.machine, raw.simulator))} sdk=${raw.sdk} videoToolbox=${JSON.stringify(raw.videoToolbox)}`);
    return caps;
  };
  return new Proxy(native, {
    get: (target, prop) => (prop === "getDecoderCaps" ? getDecoderCaps : Reflect.get(target, prop)),
  }) as T & DecoderCapsReader;
};

const nativeModule = NativeModules.MpvControl as MpvControlIosNative | undefined;
const iosReport = nativeModule?.getDeviceDecoderReport;

/**
 * Typed wrapper over `NativeModules.MpvControl` — registered by the
 * autolinked `@space/mobile-mpv-playback` package. Every call throws a clear
 * error when the package is not autolinked.
 *
 * Pass `null` for the `mode` arg of `seek` / `seekRelative` to take the
 * native default (`absolute+exact` / `relative+exact`). Numeric ids for
 * `setVideoTrack` / `setAudioTrack` / `setSubtitleTrack` are 1-indexed
 * mpv ids (use `getTrackList()` to discover them); pass `-1` to disable.
 */
export const MpvControl: MpvControlNative = nativeModule
  ? withSidecarWarmup(
      typeof iosReport === "function"
        ? withIosDecoderCaps(nativeModule, () => iosReport.call(nativeModule))
        : nativeModule,
    )
  : new Proxy(
      {} as MpvControlNative,
      {
        get(_, prop) {
          return () => {
            throw new Error(
              `MpvControl.${String(prop)} called but the native module is not available. ` +
              `Ensure @space/mobile-mpv-playback is autolinked (Android and iOS).`
            );
          };
        },
      }
    );
