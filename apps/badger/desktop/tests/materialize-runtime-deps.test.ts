import { describe, expect, it } from "vitest";

import { getPrunableRuntimePaths, shouldMaterializeRuntimeDep } from "../scripts/materialize-runtime-deps-lib.mjs";

const BUILD_AND_SOURCE_BAGGAGE = [
  "binding.gyp",
  "deps",
  "src",
  "build/deps",
  "build/Release/obj",
  "build/Release/test_extension.node",
];

describe("runtime dependency materialization", () => {
  it("prunes better-sqlite3 build/source baggage and the other platforms' prebuilds on linux", () => {
    expect(getPrunableRuntimePaths("better-sqlite3", "linux")).toEqual([
      ...BUILD_AND_SOURCE_BAGGAGE,
      "prebuilds/linuxmusl-x64.node",
      "prebuilds/linuxmusl-arm64.node",
      "prebuilds/darwin-x64.node",
      "prebuilds/darwin-arm64.node",
      "prebuilds/win32-x64.node",
      "prebuilds/win32-arm64.node",
    ]);
  });

  it("keeps both darwin prebuilds on macOS so x64, arm64 and universal builds all load", () => {
    expect(getPrunableRuntimePaths("better-sqlite3", "darwin")).toEqual([
      ...BUILD_AND_SOURCE_BAGGAGE,
      "prebuilds/linux-x64.node",
      "prebuilds/linux-arm64.node",
      "prebuilds/linuxmusl-x64.node",
      "prebuilds/linuxmusl-arm64.node",
      "prebuilds/win32-x64.node",
      "prebuilds/win32-arm64.node",
    ]);
  });

  it("keeps only the win32 prebuilds on Windows", () => {
    expect(getPrunableRuntimePaths("better-sqlite3", "win32")).toEqual([
      ...BUILD_AND_SOURCE_BAGGAGE,
      "prebuilds/linux-x64.node",
      "prebuilds/linux-arm64.node",
      "prebuilds/linuxmusl-x64.node",
      "prebuilds/linuxmusl-arm64.node",
      "prebuilds/darwin-x64.node",
      "prebuilds/darwin-arm64.node",
    ]);
  });

  it("leaves unrelated runtime dependencies untouched", () => {
    expect(getPrunableRuntimePaths("drizzle-orm", "linux")).toEqual([]);
  });

  it("@bugfix materializes only packages it prunes, so electron-builder still resolves the rest through the bun store", () => {
    // A copied-out electron-updater loses its sibling deps (fs-extra, …) and
    // electron-builder 26.15's bun traversal collector fails: "Production
    // dependency fs-extra not found for package electron-updater".
    expect(shouldMaterializeRuntimeDep("better-sqlite3")).toBe(true);
    for (const dep of ["electron-updater", "drizzle-orm", "@space/runtime-host"]) {
      expect(shouldMaterializeRuntimeDep(dep)).toBe(false);
    }
  });
});
