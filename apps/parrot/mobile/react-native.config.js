const path = require("path");
// The Google-free Android build (SF_FOSS=1, PLAT-MOBILE-06) unlinks the libraries that pull in Google Play services.
const { fossAutolinkExclusions, selfUpdateAutolink } = require("../../../packages/mobile-shell/foss.cjs");

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
    ...fossAutolinkExclusions(__dirname),
    // The self-update (REL-UPD-06): linked in every Google-free build (SF_FOSS=1), never the Play build.
    ...selfUpdateAutolink(),
  },
};
