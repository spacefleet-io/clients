// better-sqlite3 13 ships N-API prebuilds for every platform in one tarball.
// Packaging runs on the target OS (electron-builder builds AppImage on Linux,
// dmg on macOS, NSIS on Windows), so keep the prebuilds for that OS (both
// arches: macOS universal builds need x64 and arm64) and drop the rest.
// The build/ entries only exist after a from-source build.
const BETTER_SQLITE3_BUILD_AND_SOURCE_PATHS = [
  "binding.gyp",
  "deps",
  "src",
  "build/deps",
  "build/Release/obj",
  "build/Release/test_extension.node",
];

const BETTER_SQLITE3_PREBUILDS = {
  linux: ["linux-x64", "linux-arm64"],
  linuxmusl: ["linuxmusl-x64", "linuxmusl-arm64"],
  darwin: ["darwin-x64", "darwin-arm64"],
  win32: ["win32-x64", "win32-arm64"],
};

export const getPrunableRuntimePaths = (pkgName, platform = process.platform) => {
  if (pkgName === "better-sqlite3") {
    const otherPrebuilds = Object.entries(BETTER_SQLITE3_PREBUILDS)
      .filter(([family]) => family !== platform)
      .flatMap(([, targets]) => targets.map((target) => `prebuilds/${target}.node`));
    return [...BETTER_SQLITE3_BUILD_AND_SOURCE_PATHS, ...otherPrebuilds];
  }
  return [];
};

// Only packages we prune are copied out of the bun store. electron-builder
// 26.15 collects the remaining runtime deps by traversing the bun symlinks; a
// copied-out package loses its sibling dependencies and breaks that traversal.
export const shouldMaterializeRuntimeDep = (pkgName) => getPrunableRuntimePaths(pkgName).length > 0;
