const path = require("path");
// The Google-free Android build (SF_FOSS=1, PLAT-MOBILE-06) unlinks the libraries that pull in Google Play services.
const { fossAutolinkExclusions, selfUpdateAutolink } = require("../../../packages/mobile-shell/foss.cjs");

// The Apple TV target's Podfile block runs autolinking with PARROT_APPLE_TV=1 (ios/Podfile, PAR-TV-02). These modules
// stay out of that app: a TV has no camera (QR scanning is the phone's job) and no photo library to pick a profile
// picture from, and their podspecs ship no tvOS platform. The JS that reaches them never runs on a TV.
const appleTvExcluded = ["@bam.tech/react-native-image-resizer", "react-native-camera-kit", "react-native-image-picker"];
const appleTv = process.env.PARROT_APPLE_TV === "1";

// Workspace packages with native code: their names don't match the autolinker's `react-native-*` lookup, so they are
// listed by root.
module.exports = {
  dependencies: {
    "@space/mobile-media-proxy": {
      root: path.resolve(__dirname, "../../../packages/mobile-media-proxy"),
    },
    "@space/mobile-audio-playback": {
      root: path.resolve(__dirname, "../../../packages/mobile-audio-playback"),
    },
    "@space/mobile-media-volume": {
      root: path.resolve(__dirname, "../../../packages/mobile-media-volume"),
    },
    // Same-device sign-in with Badger (ACCT-PAIR-07).
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
