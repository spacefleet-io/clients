module.exports = {
  dependency: {
    platforms: {
      // sourceDir is relative to the package root (the RN CLI joins it onto `root`).
      android: {
        sourceDir: "android",
        packageImportPath: "import com.spacefleet.mediasession.SpaceMediaSessionPackage;",
        packageInstance: "new SpaceMediaSessionPackage()",
      },
      // iOS: autolinked from SpaceMediaSession.podspec at the package root.
      ios: {},
    },
  },
};
