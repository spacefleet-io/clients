/**
 * @test-id MOBILE-METRO-PRELUDE-001
 * @level unit
 *
 * The app's `react-native` is the react-native-tvos fork, but Bun's store also holds plain npm `react-native` copies
 * that other workspaces pull in, linked next to every package that peers on it. Metro resolved the startup module
 * (InitializeCore, now `react-native/setup-env`) and the `react-native` imports of such packages to those copies, so the bundle ran two React Native
 * JS copies against one native build and the app died at launch with "Property 'setImmediate' doesn't exist". Every
 * `react-native` import and the startup module must be the fork the app itself imports.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { resolve } from "metro-resolver";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FileSystemLookup, ResolutionContext } from "metro-resolver";

/** The parts of the app's Metro config this test drives (metro-config, which owns `ConfigT`, is not an app dependency). */
interface AppMetroConfig {
  resolver: Pick<
    ResolutionContext,
    | "disableHierarchicalLookup"
    | "extraNodeModules"
    | "nodeModulesPaths"
    | "resolveRequest"
    | "sourceExts"
    | "unstable_conditionNames"
    | "unstable_conditionsByPlatform"
    | "unstable_enablePackageExports"
  > & {
    assetExts: ReadonlyArray<string>;
    assetResolutions: ReadonlyArray<string>;
    blockList: RegExp | ReadonlyArray<RegExp>;
    resolverMainFields: ReadonlyArray<string>;
  };
  serializer: { getModulesRunBeforeMainModule: (entryFilePath: string) => ReadonlyArray<string> };
}

const localRequire = createRequire(import.meta.url);
const config: AppMetroConfig = localRequire("../metro.config.js");

const blockList = [config.resolver.blockList].flat();

/** What Metro's file map reports for a path: blocked paths are never crawled, so they do not exist for the resolver. */
const lookup: FileSystemLookup = (filePath) => {
  if (blockList.some((pattern) => pattern.test(filePath))) return { exists: false };
  try {
    const stats = statSync(filePath);
    return { exists: true, type: stats.isDirectory() ? "d" : "f", realPath: realpathSync(filePath) };
  } catch {
    return { exists: false };
  }
};

/** The package scope Metro's package cache reports: the closest package.json, never crossing a node_modules dir. */
const packageForModule: ResolutionContext["getPackageForModule"] = (modulePath) => {
  for (let dir = dirname(modulePath); basename(dir) !== "node_modules" && dir !== dirname(dir); dir = dirname(dir)) {
    const packageJsonPath = join(dir, "package.json");
    if (lookup(packageJsonPath).exists) {
      return { packageJson: JSON.parse(readFileSync(packageJsonPath, "utf8")), rootPath: dir, packageRelativePath: relative(dir, modulePath) };
    }
  }
  return null;
};

/** Resolves an import the way Metro's dependency graph does: the app's resolver settings over the real file system. */
const resolveFrom = (originModulePath: string, moduleName: string) => {
  const { resolver } = config;
  const context: ResolutionContext = {
    allowHaste: false,
    assetExts: new Set(resolver.assetExts),
    customResolverOptions: {},
    dev: true,
    disableHierarchicalLookup: resolver.disableHierarchicalLookup,
    extraNodeModules: resolver.extraNodeModules,
    fileSystemLookup: lookup,
    getPackage: (packageJsonPath) => (lookup(packageJsonPath).exists ? JSON.parse(readFileSync(packageJsonPath, "utf8")) : null),
    getPackageForModule: packageForModule,
    isESMImport: false,
    mainFields: resolver.resolverMainFields,
    nodeModulesPaths: resolver.nodeModulesPaths,
    originModulePath,
    preferNativePlatform: true,
    resolveAsset: (dirPath, assetName, extension) => {
      const assets = ["", ...resolver.assetResolutions.map((scale) => `@${scale}x`)]
        .map((suffix) => join(dirPath, `${assetName}${suffix}${extension}`))
        .filter((assetPath) => lookup(assetPath).exists);
      return assets.length > 0 ? assets : null;
    },
    resolveHasteModule: () => null,
    resolveHastePackage: () => null,
    resolveRequest: resolver.resolveRequest,
    sourceExts: resolver.sourceExts,
    unstable_conditionNames: resolver.unstable_conditionNames,
    unstable_conditionsByPlatform: resolver.unstable_conditionsByPlatform,
    unstable_enablePackageExports: resolver.unstable_enablePackageExports,
    // metro-config's defaults for the switches metro-resolver 0.88 added; the app's config leaves both unset.
    unstable_applyBrowserSpecAfterExports: false,
    unstable_resolveExportsFromPackageRoot: false,
    unstable_logWarning: (message) => console.warn(message),
  };
  const resolution = resolve(context, moduleName, "android");
  if (resolution.type !== "sourceFile") throw new Error(`${moduleName} resolved to ${resolution.type}`);
  return resolution.filePath;
};

const writeFile = (filePath: string, contents: string) => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
};

describe("Metro bundle startup", () => {
  // RN 0.88's startup module is `react-native/setup-env` (it sets up timers, console and the rest of the environment);
  // the old `Libraries/Core/InitializeCore` path is not an entry Metro's resolver redirect recognises, so the bundle
  // ran the app before any setup (#1641).
  it("@bugfix runs the setup-env of the react-native the app imports", () => {
    const prelude = config.serializer.getModulesRunBeforeMainModule("");
    const forkSetupEnv = localRequire.resolve("react-native/setup-env");
    console.info("[MOBILE-METRO-PRELUDE-001] prelude", JSON.stringify({ prelude, forkSetupEnv }));
    expect(prelude).toEqual([forkSetupEnv]);
    expect(realpathSync(forkSetupEnv)).toContain("react-native-tvos");
  });
});

describe("Metro react-native resolution", () => {
  const repoRoot = join(dirname(localRequire.resolve("../package.json")), "../../..");
  const forkRoot = realpathSync(dirname(localRequire.resolve("react-native/package.json")));
  // A package in Bun's store, linked next to the plain npm react-native it peers on (plus a react-native-svg).
  let storeRoot = "";
  let storeModules = "";
  let storeOrigin = "";

  beforeAll(() => {
    storeRoot = realpathSync(mkdtempSync(join(tmpdir(), "metro-rn-store-")));
    storeModules = join(storeRoot, ".bun/@react-navigation+elements@2.9.12/node_modules");
    storeOrigin = join(storeModules, "@react-navigation/elements/lib/index.js");
    writeFile(join(storeModules, "@react-navigation/elements/package.json"), JSON.stringify({ name: "@react-navigation/elements", main: "lib/index.js" }));
    writeFile(storeOrigin, "");
    writeFile(join(storeModules, "react-native/package.json"), JSON.stringify({ name: "react-native", main: "index.js" }));
    writeFile(join(storeModules, "react-native/index.js"), "");
    writeFile(join(storeModules, "react-native/Libraries/LogBox/LogBox.js"), "");
    writeFile(join(storeModules, "react-native-svg/package.json"), JSON.stringify({ name: "react-native-svg", main: "index.js" }));
    writeFile(join(storeModules, "react-native-svg/index.js"), "");
  });

  afterAll(() => {
    rmSync(storeRoot, { recursive: true, force: true });
  });

  it("the app's react-native is the react-native-tvos fork", () => {
    expect(JSON.parse(readFileSync(join(forkRoot, "package.json"), "utf8")).name).toBe("react-native-tvos");
  });

  it.each([
    ["a workspace package", () => join(repoRoot, "packages/mobile-shell/src/index.ts")],
    ["a store package linked next to another react-native", () => storeOrigin],
  ])("@bugfix resolves react-native imports from %s into the app's fork", (_from, origin) => {
    expect(resolveFrom(origin(), "react-native")).toBe(join(forkRoot, "index.js"));
    expect(resolveFrom(origin(), "react-native/Libraries/LogBox/LogBox")).toBe(join(forkRoot, "Libraries/LogBox/LogBox.js"));
  });

  it("leaves react-native-* packages to their own resolution", () => {
    expect(resolveFrom(storeOrigin, "react-native-svg")).toBe(join(storeModules, "react-native-svg/index.js"));
  });
});
