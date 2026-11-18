module.exports = {
  dependency: {
    platforms: {
      // sourceDir is relative to the package root (the RN CLI joins it onto `root`).
      android: {
        sourceDir: "android",
        packageImportPath: "import com.spacefleet.audioplayback.AudioPlaybackPackage;",
        packageInstance: "new AudioPlaybackPackage()",
      },
      ios: {},
    },
  },
};
