// Linked into the Google-free Android build only (SF_FOSS=1, packages/mobile-shell/foss.cjs, REL-UPD-06).
module.exports = {
  dependency: {
    platforms: {
      // sourceDir is relative to the package root (the RN CLI joins it onto `root`).
      android: {
        sourceDir: "android",
        packageImportPath: "import com.spacefleet.selfupdate.SelfUpdatePackage;",
        packageInstance: "new SelfUpdatePackage()",
      },
      ios: null,
    },
  },
};
