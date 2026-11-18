/**
 * @test-id PARROT-MOBILE-METRO-001
 * @level unit
 * @why metro.config.js blocks every workspace package's own node_modules (two React Native copies in one bundle crash),
 *   so a third-party runtime dependency of a bundled workspace package must be installed in the app's own
 *   node_modules. Missing one means a clean checkout's debug build red-screens at launch with "Unable to resolve
 *   module", while a machine with a leftover hand-made link still works.
 * @regression-proof @bugfix drizzle-orm (used by @space/parrot-library-db-definition and @space/library-db-definition)
 *   was only installed under those packages, so Parrot's debug build only ran after a local-only symlink.
 */
import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { unresolvableWorkspaceRuntimeDeps } from "../../../../scripts/metro-workspace-deps";

describe("parrot metro workspace resolution", () => {
  const mobileRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(mobileRoot, "../../..");
  const packageJson = JSON.parse(fs.readFileSync(path.join(mobileRoot, "package.json"), "utf-8"));
  const metroConfig = fs.readFileSync(path.join(mobileRoot, "metro.config.js"), "utf-8");
  const workspaceDeps = Object.keys(packageJson.dependencies ?? {}).filter((dep) => dep.startsWith("@space/"));
  console.info(`[parrot-metro-resolution:setup] mobileRoot=${mobileRoot} workspaceDeps=${JSON.stringify(workspaceDeps)}`);

  it.each(workspaceDeps)("%s is registered in metro.config.js workspacePackages", (dep) => {
    expect(metroConfig).toContain(`'${dep}'`);
  });

  // @req REL-ENV-25[parrot]
  it("third-party runtime deps of workspace packages resolve from the app's node_modules", () => {
    const missing = unresolvableWorkspaceRuntimeDeps(mobileRoot, repoRoot, workspaceDeps, (line) =>
      console.info(`[parrot-metro-resolution:third-party] ${line}`),
    );
    if (missing.length > 0) console.error(`[parrot-metro-resolution:third-party] missing=${JSON.stringify(missing)}`);
    expect(missing).toEqual([]);
  });
});
