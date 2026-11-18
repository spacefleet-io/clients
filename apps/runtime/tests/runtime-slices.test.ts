import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { discoverRuntimeModules } from "../src/slices";

const baseManifest = {
  version: "0.1.0",
  runtimeApiVersion: "1",
  entrypoint: "lib/index.js",
  platform: "dev-any",
  artifacts: [{ path: "lib/index.js", sha256: "dev-placeholder" }],
};

const writeModuleManifest = (root: string, moduleName: string, manifest: Record<string, unknown>) => {
  const dir = joinPath(root, "modules", moduleName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(joinPath(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
};

const dumpSlicesSnapshot = (label: string, ctx: { root?: string | null; modules?: ReturnType<typeof discoverRuntimeModules> | null }) => {
  try {
    console.error(`=== [runtime-slices:${label}] snapshot ===`);
    console.error(`slicesRoot=${ctx.root ?? "<none>"}`);
    if (ctx.modules) {
      const dump: Record<string, unknown> = {};
      for (const [k, v] of ctx.modules.entries()) dump[k] = v;
      console.error(`modules=${JSON.stringify(dump, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runtime slice discovery [runtime-slices]", () => {
  const dirs: string[] = [];

  afterEach(() => {
    console.info(`[runtime-slices:after-each] cleaning ${dirs.length} temp dirs`);
    for (const dir of dirs.splice(0, dirs.length)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks the badger module installed and ready when its manifest is compatible", () => {
    const root = mkdtempSync(joinPath(tmpdir(), "runtime-slices-"));
    dirs.push(root);
    console.info(`[runtime-slices:compatible-badger] tempRoot=${root}, writing badger manifest`);
    writeModuleManifest(root, "badger", { sliceId: "runtime-badger", moduleId: "badger", ...baseManifest });

    const modules = discoverRuntimeModules({ slicesRoot: root, runtimeApiVersion: "1" });
    const badger = modules.get("badger");
    const parrot = modules.get("parrot");
    console.info(
      `[runtime-slices:compatible-badger] badger.installed=${badger?.installed} ready=${badger?.ready} compatibility=${badger?.compatibility}; parrot.compatibility=${parrot?.compatibility}`,
    );
    try {
      expect(badger).toMatchObject({ installed: true, ready: true, compatibility: "compatible", sliceId: "runtime-badger" });
      expect(parrot).toMatchObject({ installed: false, ready: false, compatibility: "missing_slice" });
    } catch (err) {
      dumpSlicesSnapshot("compatible-badger-failure", { root, modules });
      throw err;
    }
  });

  it("marks module degraded when runtimeApiVersion is incompatible", () => {
    const root = mkdtempSync(joinPath(tmpdir(), "runtime-slices-"));
    dirs.push(root);
    console.info(`[runtime-slices:incompatible-api] tempRoot=${root}, runtimeApiVersion=999 vs runtime=1`);
    writeModuleManifest(root, "badger", {
      sliceId: "runtime-badger",
      moduleId: "badger",
      ...baseManifest,
      runtimeApiVersion: "999",
    });

    const modules = discoverRuntimeModules({ slicesRoot: root, runtimeApiVersion: "1" });
    const badger = modules.get("badger");
    console.info(
      `[runtime-slices:incompatible-api] badger=${JSON.stringify({ installed: badger?.installed, ready: badger?.ready, status: badger?.status, compatibility: badger?.compatibility })}`,
    );
    try {
      expect(badger).toMatchObject({
        installed: true,
        ready: false,
        status: "degraded",
        compatibility: "incompatible_api",
      });
    } catch (err) {
      dumpSlicesSnapshot("incompatible-api-failure", { root, modules });
      throw err;
    }
  });

  it("marks module error when manifest is invalid", () => {
    const root = mkdtempSync(joinPath(tmpdir(), "runtime-slices-"));
    dirs.push(root);
    console.info(`[runtime-slices:invalid-manifest] tempRoot=${root}, omitting required sliceId`);
    writeModuleManifest(root, "parrot", {
      moduleId: "parrot",
      ...baseManifest,
    });

    const modules = discoverRuntimeModules({ slicesRoot: root, runtimeApiVersion: "1" });
    const parrot = modules.get("parrot");
    console.info(
      `[runtime-slices:invalid-manifest] parrot=${JSON.stringify({ installed: parrot?.installed, ready: parrot?.ready, status: parrot?.status, compatibility: parrot?.compatibility })}`,
    );
    try {
      expect(parrot).toMatchObject({
        installed: true,
        ready: false,
        status: "error",
        compatibility: "invalid_manifest",
      });
    } catch (err) {
      dumpSlicesSnapshot("invalid-manifest-failure", { root, modules });
      throw err;
    }
  });
});
