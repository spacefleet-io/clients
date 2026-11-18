// @space/mobile-audio-playback: the in-app music player of the suite phone apps (Parrot, PAR-PLAY-01). Android: one
// Media3 ExoPlayer in a MediaSessionService; iPhone (ios/AudioPlayback): an AVQueuePlayer with the same queue rules,
// even volume and limiter. Music keeps playing in the background with notification / lock-screen and headset controls
// (PAR-PLAY-03). Items are URLs the player can stream with byte ranges (the loopback media proxy).
import { DeviceEventEmitter, NativeModules, type EmitterSubscription } from "react-native";

export type AudioQueueItem = {
  id: string;
  url: string;
  mimeType?: string;
  title: string;
  artist?: string;
  album?: string;
  /** The cover the notification and lock-screen card show: a local `file://` picture on the device, never a remote URL. */
  artworkUri?: string;
  /** The song's even-volume gain in dB (PAR-PLAY-03 item 2), applied from its first sample; absent = as recorded. */
  gainDb?: number;
  /** Names this queue entry for the app: the state's `key` (the song playing) and `nextKey` (the one after it). */
  key?: string;
};

export type AudioPlaybackState = {
  state: "idle" | "buffering" | "ready" | "ended";
  playing: boolean;
  playWhenReady: boolean;
  /**
   * A phone call, an alarm or a voice assistant holds the music back for a moment (PLAY-FOCUS-01 item 2): no sound,
   * `playWhenReady` stays true and the player plays again by itself when that moment ends.
   */
  suppressed: boolean;
  positionMs: number;
  /** -1 until the player knows it. */
  durationMs: number;
  index: number;
  count: number;
  /** The `key` of the song playing, null when it has none. */
  key?: string | null;
  /** The `key` of the song that plays after it (shuffle and repeat included), null when none or it has no key. */
  nextKey?: string | null;
  mediaId: string | null;
  /** Media3 error code name (e.g. `ERROR_CODE_IO_CLEARTEXT_NOT_PERMITTED`) of the last failure, else null. The
   * iPhone maps its AVFoundation errors onto the same names. */
  error: string | null;
  /** Shuffle is on: the queue plays in an order Media3 draws, starting from the current song. */
  shuffle: boolean;
  repeat: AudioRepeatMode;
};

export type AudioRepeatMode = "off" | "all" | "one";

/**
 * The play/pause button shows pause: the music plays or is about to (buffering). A moment's hold (a call) shows play,
 * like the operating system's card, since nothing sounds then (PLAY-FOCUS-01 item 5); so does the end of the queue.
 */
export const showsPause = (state: Pick<AudioPlaybackState, "playWhenReady" | "suppressed" | "state">): boolean =>
  state.playWhenReady && !state.suppressed && state.state !== "ended";

/** Where added songs go: "next" right after the song playing (Play next), "end" after the last one (Add to queue). */
export type AudioQueueInsert = "next" | "end";

type NativeAudioPlayback = {
  setQueue: (itemsJson: string, startIndex: number, startPositionMs: number) => Promise<AudioPlaybackState>;
  addItems: (itemsJson: string, where: AudioQueueInsert) => Promise<AudioPlaybackState>;
  play: () => Promise<AudioPlaybackState>;
  pause: () => Promise<AudioPlaybackState>;
  next: () => Promise<AudioPlaybackState>;
  previous: () => Promise<AudioPlaybackState>;
  seekTo: (positionMs: number) => Promise<AudioPlaybackState>;
  getState: () => Promise<AudioPlaybackState>;
  getUpNext: () => Promise<string[]>;
  stop: () => Promise<AudioPlaybackState>;
  setShuffle: (enabled: boolean) => Promise<AudioPlaybackState>;
  setGains: (gainsJson: string) => Promise<void>;
  setLimiting: (on: boolean) => Promise<void>;
  setRepeatMode: (mode: AudioRepeatMode) => Promise<AudioPlaybackState>;
  canShowOutputSwitcher: () => Promise<boolean>;
  showOutputSwitcher: () => Promise<boolean>;
};

const native = NativeModules.AudioPlayback as NativeAudioPlayback | undefined;

const requireNative = (): NativeAudioPlayback => {
  if (!native) throw new Error("audio_playback_unavailable");
  return native;
};

export const AudioPlayback = {
  /** Replaces the queue with `items` and plays `items[startIndex]` from `startPositionMs`. */
  setQueue: (items: AudioQueueItem[], startIndex = 0, startPositionMs = 0) =>
    requireNative().setQueue(JSON.stringify(items), startIndex, startPositionMs),
  /**
   * Adds `items` without stopping the song playing, also with shuffle on: "next" plays them right after it, "end"
   * after the last song. An empty queue starts playing them.
   */
  addItems: (items: AudioQueueItem[], where: AudioQueueInsert) => requireNative().addItems(JSON.stringify(items), where),
  play: () => requireNative().play(),
  pause: () => requireNative().pause(),
  next: () => requireNative().next(),
  previous: () => requireNative().previous(),
  seekTo: (positionMs: number) => requireNative().seekTo(Math.max(0, Math.round(positionMs))),
  getState: () => requireNative().getState(),
  /** The ids of the songs that play after the current one, in the player's order (shuffled, wrapping with repeat all). */
  getUpNext: () => requireNative().getUpNext(),
  /** Clears the queue and lets the service stop (sign out). */
  stop: () => requireNative().stop(),
  setShuffle: (enabled: boolean) => requireNative().setShuffle(enabled),
  /** Changes songs' even-volume gains by item id, the playing song's included (from its next samples). */
  setGains: (gains: Record<string, number>) => requireNative().setGains(JSON.stringify(gains)),
  /** Even out volume at Loud: the limiter keeps the lifted peaks at −1 dB (from the next samples). */
  setLimiting: (on: boolean) => requireNative().setLimiting(on),
  /** "off", "all" (the queue starts over after its last song) or "one" (the same song again). */
  setRepeatMode: (mode: AudioRepeatMode) => requireNative().setRepeatMode(mode),
  /** True where the system has its own "play on" picker (Android 11 and later, every iPhone); false without the
   * native module. */
  canShowOutputSwitcher: () => (native ? native.canShowOutputSwitcher() : Promise.resolve(false)),
  /** Opens the system's "play on" picker (Android's output switcher, the iPhone's AirPlay picker); resolves false
   * when none opened. */
  showOutputSwitcher: () => requireNative().showOutputSwitcher(),
  /** Every player change (play, pause, track, buffering, error). Positions between changes come from `getState`. */
  onState: (listener: (state: AudioPlaybackState) => void): EmitterSubscription =>
    DeviceEventEmitter.addListener("AudioPlaybackState", listener),
};
