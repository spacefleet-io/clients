// react-native-google-cast in the Google-free Android build (SF_FOSS=1, metro.config.js): the Cast SDK is Google Play
// services, so that build links no Cast native module and resolves the library's imports here instead. No Cast
// device is ever found, so no Cast row or button shows (googleCastAvailable.foss.ts hides the player's), and the calls
// the app makes outside a cast resolve without doing anything. The enums are the library's own pure-TS files. The types
// come from the package's published declarations: its src/api files do not type-check under this tsconfig, and a
// type-only import is erased, so Metro never resolves it to this file.
import type { CastSession, Device } from "react-native-google-cast";

export { default as MediaHlsSegmentFormat } from "react-native-google-cast/src/types/MediaHlsSegmentFormat";
export { default as MediaHlsVideoSegmentFormat } from "react-native-google-cast/src/types/MediaHlsVideoSegmentFormat";
export { default as MediaPlayerIdleReason } from "react-native-google-cast/src/types/MediaPlayerIdleReason";
export { default as MediaPlayerState } from "react-native-google-cast/src/types/MediaPlayerState";
export { default as MediaStreamType } from "react-native-google-cast/src/types/MediaStreamType";
export type { CastSession, Device };

const NO_DEVICES: Device[] = [];
const nothing = async (): Promise<void> => undefined;
const unavailable = (): Promise<never> => Promise.reject(new Error("Google Cast is not part of this build"));

const discoveryManager = { startDiscovery: nothing, stopDiscovery: nothing, getDevices: async () => NO_DEVICES };
const sessionManager = { endCurrentSession: nothing, getCurrentCastSession: async () => null, startSession: unavailable };

export const CastContext = {
  getDiscoveryManager: () => discoveryManager,
  getSessionManager: () => sessionManager,
};

/** No Cast device is ever found. */
export const useDevices = (): Device[] => NO_DEVICES;
