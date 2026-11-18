/**
 * @test-id MOBILE-METRO-001
 * @level unit
 * @why Metro bundler configuration errors cause runtime crashes that are hard
 *   to diagnose: missing workspace packages → "unable to resolve module",
 *   duplicate React copies → "Cannot read property 'useContext' of null".
 *   These static checks catch configuration drift before the app runs.
 * @regression-proof
 *   Bug #1: @space/mobile-shell not in extraNodeModules.
 *   Bug #2: Dual React from workspace node_modules not blocked.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import { createRequire } from "module";
import path from "path";
import { unresolvableWorkspaceRuntimeDeps } from "../../../../scripts/metro-workspace-deps";

describe("metro workspace resolution", () => {
  const mobileRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(mobileRoot, "../../..");
  const metroConfigPath = path.join(mobileRoot, "metro.config.js");
  const packageJsonPath = path.join(mobileRoot, "package.json");
  const vitestConfigPath = path.join(mobileRoot, "vitest.config.ts");

  console.info(`[metro-workspace-resolution:setup] mobileRoot=${mobileRoot} repoRoot=${repoRoot}`);
  const metroConfig = fs.readFileSync(metroConfigPath, "utf-8");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
  const vitestConfig = fs.readFileSync(vitestConfigPath, "utf-8");
  console.info(
    `[metro-workspace-resolution:setup] read metro.config.js (${metroConfig.length}b) package.json (${Object.keys(packageJson.dependencies ?? {}).length} deps) vitest.config.ts (${vitestConfig.length}b)`,
  );

  // Only runtime dependencies reach the Metro bundle; workspace devDependencies (test-seed, mpv-protocol) are test and
  // e2e tooling that Metro never resolves.
  const workspaceDeps = Object.keys(packageJson.dependencies ?? {}).filter((dep) => dep.startsWith("@space/"));
  console.info(`[metro-workspace-resolution:setup] workspaceDeps(${workspaceDeps.length})=${JSON.stringify(workspaceDeps)}`);

  // Dump-on-failure: print the config artifacts + the dep under inspection so a
  // failing static-config assertion is diagnosable without re-reading files.
  // try/catch so a dump failure can't mask the real assertion.
  const dumpMetroSnapshot = (label: string, extra: Record<string, unknown>) => {
    try {
      console.error(`=== [metro-workspace-resolution:${label}] snapshot ===`);
      console.error(`workspaceDeps=${JSON.stringify(workspaceDeps)}`);
      console.error(`metroConfig length=${metroConfig.length} hasBlockList=${metroConfig.includes("workspaceNodeModulesBlockList")}`);
      console.error(`context: ${JSON.stringify(extra)}`);
    } catch (err) {
      console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
    }
  };

  it.each(workspaceDeps)(
    "%s is registered in metro.config.js extraNodeModules",
    (dep) => {
      const registered = metroConfig.includes(`'${dep}'`);
      console.info(`[metro-workspace-resolution:extra-node-modules] dep=${dep} registered=${registered}`);
      if (!registered) dumpMetroSnapshot("extra-node-modules", { dep });
      expect(metroConfig).toContain(`'${dep}'`);
    },
  );

  it("workspace packages' node_modules are blocked to prevent dual-instance issues", () => {
    console.info(`[metro-workspace-resolution:blocklist] verifying workspaceNodeModulesBlockList present + each pkg blocked`);
    const hasBlockList = metroConfig.includes("workspaceNodeModulesBlockList");
    if (!hasBlockList) dumpMetroSnapshot("blocklist", { hasBlockList });
    expect(metroConfig).toContain("workspaceNodeModulesBlockList");
    for (const dep of workspaceDeps) {
      const pkgName = dep.replace("@space/", "");
      const pkgDir = path.join(repoRoot, "packages", pkgName);
      if (fs.existsSync(pkgDir)) {
        const blocked = metroConfig.includes(`packages/${pkgName}`);
        console.info(`[metro-workspace-resolution:blocklist] pkg=${pkgName} exists=true blocked=${blocked}`);
        if (!blocked) dumpMetroSnapshot("blocklist", { dep, pkgName, pkgDir });
        expect(metroConfig).toContain(`packages/${pkgName}`);
      }
    }
  });

  it("no unblocked duplicate React in workspace packages", () => {
    console.info(`[metro-workspace-resolution:dup-react] scanning workspace packages for own react copy`);
    for (const dep of workspaceDeps) {
      const pkgName = dep.replace("@space/", "");
      const reactDir = path.join(repoRoot, "packages", pkgName, "node_modules", "react");
      if (fs.existsSync(reactDir)) {
        // If a workspace package has its own react, it MUST be blocked by Metro
        const blocked = metroConfig.includes(`packages/${pkgName}`);
        console.info(`[metro-workspace-resolution:dup-react] pkg=${pkgName} hasOwnReact=true blocked=${blocked}`);
        if (!blocked) dumpMetroSnapshot("dup-react", { dep, pkgName, reactDir });
        expect(metroConfig).toContain(`packages/${pkgName}`);
      }
    }
  });

  // @bugfix @regression-proof (#304): drizzle-orm was only installed under
  // packages/library-db-definition/node_modules, which the blocklist above hides
  // from Metro → red screen "Unable to resolve module drizzle-orm/sqlite-core".
  // Because workspace node_modules are blocked, every third-party runtime dep of
  // a consumed workspace package must be installed in the app's own node_modules.
  // Only deps the app can bundle count: a dep imported solely behind an export the
  // app never loads never reaches Metro.
  // @req REL-ENV-25[badger-mobile,badger-tv]
  it("third-party runtime deps of workspace packages resolve from the app's node_modules", () => {
    const missing = unresolvableWorkspaceRuntimeDeps(mobileRoot, repoRoot, workspaceDeps, (line) =>
      console.info(`[metro-workspace-resolution:third-party] ${line}`),
    );
    if (missing.length > 0) dumpMetroSnapshot("third-party", { missing });
    expect(missing).toEqual([]);
  });

  it.each(workspaceDeps)(
    "%s has a matching vitest resolve alias",
    (dep) => {
      // Every workspace dep in metro config should also have a vitest alias
      // so tests resolve imports the same way Metro does
      const aliasKey = `"${dep}"`;
      const hasAlias = vitestConfig.includes(aliasKey);
      console.info(`[metro-workspace-resolution:vitest-alias] dep=${dep} hasAlias=${hasAlias}`);
      if (!hasAlias) dumpMetroSnapshot("vitest-alias", { dep, aliasKey });
      expect(vitestConfig).toContain(aliasKey);
    },
  );

  // @bugfix @regression-proof
  // Metro crashed (ENOENT in FallbackWatcher#watchdir) when a gradle build ran
  // while it was up: CMake creates and deletes temp dirs under
  // node_modules/<native lib>/android/.cxx faster than the watcher can attach.
  // Native build output must never be watched.
  it("native build output dirs are excluded from Metro's watcher", () => {
    const loaded = createRequire(metroConfigPath)(metroConfigPath) as { resolver: { blockList: RegExp | RegExp[] } };
    const blockList = ([] as RegExp[]).concat(loaded.resolver.blockList);
    const bunModules = path.join(repoRoot, "node_modules/.bun");
    const nativePaths = [
      path.join(bunModules, "react-native-quick-crypto@1.0.18+x/node_modules/react-native-quick-crypto/android/.cxx/RelWithDebInfo/p2/arm64-v8a/CMakeFiles/CMakeTmp/CMakeFiles/cmTC_064ed.dir"),
      path.join(bunModules, "react-native-screens@4.0.0/node_modules/react-native-screens/android/build/intermediates/x"),
      path.join(repoRoot, "packages/mobile-mpv-playback/android/build/tmp/kotlin-classes"),
      path.join(repoRoot, "packages/mobile-mpv-playback/android/.cxx/Debug"),
      path.join(mobileRoot, "android/app/build/generated/x"),
      path.join(mobileRoot, "android/.gradle/8.13"),
    ];
    const sourcePaths = [
      path.join(mobileRoot, "src/screens/PlayerScreen.tsx"),
      path.join(repoRoot, "packages/mobile-mpv-playback/src/index.ts"),
      path.join(bunModules, "react-native-screens@4.0.0/node_modules/react-native-screens/lib/module/index.js"),
    ];
    const blocked = (p: string) => blockList.some((re) => re.test(p));
    for (const p of [...nativePaths, ...sourcePaths]) {
      console.info(`[metro-workspace-resolution:native-build] blocked=${blocked(p)} path=${p}`);
    }
    const unblockedNative = nativePaths.filter((p) => !blocked(p));
    const blockedSource = sourcePaths.filter(blocked);
    if (unblockedNative.length || blockedSource.length) dumpMetroSnapshot("native-build", { unblockedNative, blockedSource });
    expect(unblockedNative).toEqual([]);
    expect(blockedSource).toEqual([]);
  });
});
