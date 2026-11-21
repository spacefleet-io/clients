import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { createBuilderConfig } from "../electron-builder.config.mjs";
import { resolveDesktopDevEnv } from "../../../../scripts/desktop-dev-lane.mjs";

const packageJsonPath = resolve(import.meta.dirname, "../package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
  productName?: string;
  scripts?: Record<string, string>;
  desktopName?: string;
};

type BuilderConfig = {
  appId?: string;
  extraResources?: Array<{ from?: string; to?: string }>;
  linux?: { executableName?: string };
};
const linuxConfig = createBuilderConfig({ targetId: "linux-x64" }) as BuilderConfig;

// Dump-on-failure: surface the resolved package.json fields under assertion so a
// packaging-config regression is diagnosable without rerun. Wrapped in try/catch
// so a dump failure can never mask the real assertion.
const dumpPackagingSnapshot = (label: string, extra?: Record<string, unknown>) => {
  try {
    console.error(`=== [packaging:${label}] snapshot ===`);
    console.error(`packageJsonPath=${packageJsonPath}`);
    console.error(
      `identity: productName=${JSON.stringify(packageJson.productName)} desktopName=${JSON.stringify(packageJson.desktopName)} appId=${JSON.stringify(linuxConfig.appId)}`,
    );
    console.error(`scripts.dev=${JSON.stringify(packageJson.scripts?.dev)}`);
    console.error(`scripts.package=${JSON.stringify(packageJson.scripts?.package)}`);
    console.error(`build.extraResources=${JSON.stringify(linuxConfig.extraResources, null, 2)}`);
    if (extra) console.error(`extra=${JSON.stringify(extra, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("desktop packaging", () => {
  it("defaults the devtools port to 9222 while preserving overrides for electron MCP access", () => {
    // The dev launcher (scripts/dev.mjs) takes its env from the shared lane resolver; the main process opens the
    // devtools port from SF_DEVTOOLS_PORT. No lane: the app's default port; a caller's SF_DEVTOOLS_PORT wins.
    const cwd = mkdtempSync(join(tmpdir(), "sf-packaging-devtools-"));
    const env = { HOME: cwd };
    const byDefault = resolveDesktopDevEnv({ app: "badger-desktop", env, cwd }).env.SF_DEVTOOLS_PORT;
    const overridden = resolveDesktopDevEnv({ app: "badger-desktop", env: { ...env, SF_DEVTOOLS_PORT: "9333" }, cwd }).env
      .SF_DEVTOOLS_PORT;
    console.info(
      `[packaging:devtools-port] scripts.dev=${JSON.stringify(packageJson.scripts?.dev)} default=${byDefault} override=${overridden}`,
    );
    try {
      expect(packageJson.scripts?.dev).toContain("scripts/dev.mjs");
      expect(byDefault).toBe("9222");
      expect(overridden).toBe("9333");
    } catch (err) {
      dumpPackagingSnapshot("devtools-port", { cwd, byDefault, overridden });
      throw err;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("declares a distinct desktop identity for OS taskbar grouping", () => {
    console.info(
      `[packaging:identity] productName=${JSON.stringify(packageJson.productName)} desktopName=${JSON.stringify(packageJson.desktopName)} appId=${JSON.stringify(linuxConfig.appId)}`,
    );
    try {
      expect(packageJson.productName).toBe("Badger");
      expect(packageJson.desktopName).toBe("spacebadger.desktop");
      expect(linuxConfig.appId).toBe("io.spacefleet.badger-desktop");
    } catch (err) {
      dumpPackagingSnapshot("identity");
      throw err;
    }
  });

  it("fetches the published media-deps bundle before packaging", () => {
    console.info(`[packaging:fetch-deps] checking fetch-deps + package script wiring`);
    try {
      // The reduced ffmpeg/ffprobe/mpv builds are published by packages/media-deps (#248); packaging
      // fetches them (sha256-verified) rather than building anything.
      expect(packageJson.scripts?.["package:prepare-binaries"]).toBeUndefined();
      // `package` is one host-agnostic orchestrator; the steps live in scripts/package.mjs.
      expect(packageJson.scripts?.package).toBe("node ./scripts/package.mjs --target linux-x64");
      expect(packageJson.scripts?.["package:windows"]).toBe("node ./scripts/package.mjs --target windows-x64");
      expect(packageJson.scripts?.["package:macos-arm64"]).toBe("node ./scripts/package.mjs --target macos-arm64");
      expect(packageJson.scripts?.["package:macos-x64"]).toBe("node ./scripts/package.mjs --target macos-x64");
      const orchestrator = readFileSync(resolve(import.meta.dirname, "../scripts/package.mjs"), "utf8");
      expect(orchestrator).toContain('"fetch-deps.ts"');
      expect(orchestrator).toContain("materialize-runtime-deps.mjs");
      expect(orchestrator).not.toContain("npm install");
      expect(orchestrator).not.toContain("npm prune");
    } catch (err) {
      dumpPackagingSnapshot("fetch-deps");
      throw err;
    }
  });

  it("packages the fetched media-deps bundle (flat bin/ + manifest) under resources/deps", () => {
    console.info(
      `[packaging:deps-bundle] extraResources entries=${linuxConfig.extraResources?.length ?? 0}`,
    );
    try {
      const repoRoot = resolve(import.meta.dirname, "../../../..");
      expect(linuxConfig.extraResources).toContainEqual({
        from: resolve(repoRoot, "vendor/deps/linux-x64"),
        to: "deps",
      });
      // no legacy ffmpeg / mpv-bundle / AppImage locations
      for (const resource of linuxConfig.extraResources ?? []) {
        const to = typeof resource === "string" ? resource : resource.to;
        expect(to).not.toMatch(/^(ffmpeg|mpv\/linux-bundle)$/);
        expect(to).not.toBe("mpv");
      }
    } catch (err) {
      dumpPackagingSnapshot("deps-bundle");
      throw err;
    }
  });

  it("@bugfix names the linux executable with path-safe characters (electron-builder 26.15 rejects '@space/…')", () => {
    expect(linuxConfig.linux?.executableName).toBe("spacebadger");
    expect(linuxConfig.linux?.executableName).toMatch(/^[A-Za-z0-9._ -]+$/);
  });
});
