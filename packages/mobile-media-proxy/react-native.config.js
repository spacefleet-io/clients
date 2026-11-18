module.exports = {
  dependency: {
    platforms: {
      // sourceDir must be RELATIVE to the package root (the RN CLI joins it onto the package root).
      android: {
        sourceDir: "android",
        packageImportPath: "import com.spacefleet.mediaproxy.MediaProxyPackage;",
        packageInstance: "new MediaProxyPackage()",
      },
      // iOS: the MediaProxy pod (MediaProxy.podspec, sources in ios/), same `PlaybackBridge` / `DownloadsBridge` modules.
      ios: {},
    },
  },
};
