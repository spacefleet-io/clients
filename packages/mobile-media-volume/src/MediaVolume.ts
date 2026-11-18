import { NativeEventEmitter, NativeModules, type EmitterSubscription } from "react-native";
import { clampLevel } from "./level";

type MediaVolumeNative = {
  getMediaVolume: () => Promise<number>;
  setMediaVolume: (level: number) => Promise<number>;
  addListener: (eventName: string) => void;
  removeListeners: (count: number) => void;
};

const native = NativeModules.MediaVolume as MediaVolumeNative | undefined;
// The module goes to the emitter on Android too: its addListener is what registers the volume receiver natively.
const emitter = native ? new NativeEventEmitter<{ mediaVolumeChanged: [level: number] }>(native as never) : null;

const requireNative = (): MediaVolumeNative => {
  if (!native) throw new Error("media_volume_unavailable: @space/mobile-media-volume is not autolinked");
  return native;
};

/**
 * The device's media volume (Android STREAM_MUSIC, iOS output volume) as 0..1 — the level the hardware volume buttons
 * move during playback. Shared by both phone apps (PAR-PLAY-05).
 */
export const MediaVolume = {
  get: (): Promise<number> => requireNative().getMediaVolume(),
  /** Sets the level (0 = mute, 1 = max) without the system volume panel; resolves the level applied (Android rounds it
   *  to the stream's steps). Rejects `volume_denied` when Do Not Disturb refuses, and always on tvOS. */
  set: (level: number): Promise<number> => requireNative().setMediaVolume(clampLevel(level)),
  /** Fires with the new level whenever the media volume changes: hardware buttons, system panel, Bluetooth, `set`. */
  onChange: (listener: (level: number) => void): EmitterSubscription => {
    if (!emitter) throw new Error("media_volume_unavailable: @space/mobile-media-volume is not autolinked");
    return emitter.addListener("mediaVolumeChanged", (level: number) => listener(clampLevel(level)));
  },
};
