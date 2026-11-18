module.exports = {
  dependency: {
    platforms: {
      // sourceDir must be RELATIVE to the package root — the RN CLI's
      // android dependencyConfig does `path.join(root, sourceDir)` and an
      // absolute path here produces a broken concatenated path that fails
      // the `findManifest` / `findPackageClassName` lookups silently.
      android: {
        sourceDir: "android",
        packageImportPath: "import com.spacefleet.mpvplayback.MpvPlaybackPackage;",
        packageInstance: "new MpvPlaybackPackage()",
      },
      ios: {},
    },
  },
};
