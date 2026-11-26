const path = require("path");
// The Google-free Android build (SF_FOSS=1, PLAT-MOBILE-06) unlinks the libraries that pull in Google Play services.
const { fossAutolinkExclusions, selfUpdateAutolink } = require("@space/mobile-shell/foss");

// The Apple TV target's Podfile block runs autolinking with SB_APPLE_TV=1 (ios/Podfile). These modules stay out
// of that app: a TV has no camera (QR scanning is the phone's job), no push, no WKWebView, no background
// downloads, no Google Cast sender (the Cast SDK is iOS-only) and no file picker (PLAY-SUBGET-23), and their podspecs
// ship no tvOS platform. The JS that reaches them never runs on a TV.
const appleTvExcluded = [
  "@react-native-documents/picker",
  "@react-native-firebase/app",
  "@react-native-firebase/messaging",
  "react-native-blob-util",
  "react-native-camera-kit",
  "react-native-google-cast",
  "react-native-webview",
];
const appleTv = process.env.SB_APPLE_TV === "1";

module.exports = {
  assets: ["./src/assets/fonts"],
  // Explicit autolink for workspace packages whose names don't match RN's
  // built-in `react-native-*` heuristic. Without this entry the autolinker
  // skips @space/mobile-mpv-playback and the libmpv AAR never reaches the
  // app classpath.
  dependencies: {
    "@space/mobile-mpv-playback": {
      root: path.resolve(__dirname, "../../../packages/mobile-mpv-playback"),
    },
    // The playback proxy and offline downloads (PlaybackBridge, DownloadsBridge), shared with Parrot's phone app.
    "@space/mobile-media-proxy": {
      root: path.resolve(__dirname, "../../../packages/mobile-media-proxy"),
    },
    // The media volume (player gestures), shared with Parrot's phone app (PAR-PLAY-05).
    "@space/mobile-media-volume": {
      root: path.resolve(__dirname, "../../../packages/mobile-media-volume"),
    },
    // Same-device sign-in with Parrot (ACCT-PAIR-07), shared with Parrot's phone app.
    "@space/mobile-sibling": {
      root: path.resolve(__dirname, "../../../packages/mobile-sibling"),
    },
    ...(appleTv
      ? Object.fromEntries(appleTvExcluded.map((name) => [name, { platforms: { ios: null } }]))
      : {}),
    ...fossAutolinkExclusions(__dirname),
    // The self-update (REL-UPD-06): linked in every Google-free build (SF_FOSS=1), never the Play build.
    ...selfUpdateAutolink(),
  },
};
