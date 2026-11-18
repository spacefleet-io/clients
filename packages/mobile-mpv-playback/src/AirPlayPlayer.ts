import { NativeModules, Platform, requireNativeComponent, type ViewProps } from "react-native";

export type AirPlayRoute = { active: boolean; name: string | null };

export type AirPlayStatus = "idle" | "loading" | "playing" | "paused" | "ended" | "failed";

export type AirPlayState = {
  route: AirPlayRoute;
  /** The AVPlayer is really playing on the AirPlay device (`isExternalPlaybackActive`). */
  external: boolean;
  status: AirPlayStatus;
  position: number;
  duration: number;
  /** Set when `status` is `failed`, or the route was left (`airplay_route_lost`). */
  error: string | null;
};

type AirPlayNative = {
  getRoute: () => Promise<AirPlayRoute>;
  load: (url: string, startSeconds: number) => Promise<boolean>;
  play: () => Promise<boolean>;
  pause: () => Promise<boolean>;
  seek: (seconds: number) => Promise<boolean>;
  stop: () => Promise<boolean>;
  getState: () => Promise<AirPlayState>;
  /** Index into the stream's legible options; -1 = off. */
  setSubtitleIndex: (index: number) => Promise<boolean>;
};

const native: AirPlayNative | undefined = Platform.OS === "ios" ? (NativeModules.AirPlayPlayer as AirPlayNative | undefined) : undefined;

const missing = (name: string): never => {
  throw new Error(`AirPlayPlayer.${name} called but the native module is not available (iPhone only).`);
};

/**
 * AirPlay for the iPhone (UX-TV-03). Apple's AVPlayer is used ONLY to hand the HLS stream of the cast server to the
 * AirPlay device (`allowsExternalPlayback`); it is never allowed to play on the phone (MPV-MODEL-02): `load` refuses unless an
 * AirPlay route is already active, the player stays muted and paused until the external playback is really active, and it
 * stops itself when the route is left.
 */
export const AirPlayPlayer = {
  available: native !== undefined,
  getRoute: (): Promise<AirPlayRoute> => (native ? native.getRoute() : Promise.resolve({ active: false, name: null })),
  load: (url: string, startSeconds: number): Promise<boolean> => (native ? native.load(url, startSeconds) : missing("load")),
  play: (): Promise<boolean> => (native ? native.play() : missing("play")),
  pause: (): Promise<boolean> => (native ? native.pause() : missing("pause")),
  seek: (seconds: number): Promise<boolean> => (native ? native.seek(seconds) : missing("seek")),
  stop: (): Promise<boolean> => (native ? native.stop() : Promise.resolve(true)),
  getState: (): Promise<AirPlayState> => (native ? native.getState() : missing("getState")),
  setSubtitleIndex: (index: number): Promise<boolean> => (native ? native.setSubtitleIndex(index) : missing("setSubtitleIndex")),
};

export type AirPlayRoutePickerProps = ViewProps & {
  /** Colour of the AirPlay glyph. */
  tintColor?: string;
  /** Colour while a route is active. */
  activeTintColor?: string;
  /** Show video-capable devices first. */
  prioritizesVideoDevices?: boolean;
};

/** Apple's `AVRoutePickerView` (the AirPlay button). iPhone only; renders nothing elsewhere. */
export const AirPlayRoutePickerView = Platform.OS === "ios" ? requireNativeComponent<AirPlayRoutePickerProps>("AirPlayRoutePickerView") : null;
