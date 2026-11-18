import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { getDefaultSlicesRoot, validateRuntimeSlicePackaging } from "../src/slicePackagingGuard";

const writeManifest = (
  root: string,
  moduleId: string,
  artifacts: Array<{ path: string; sha256?: string }> = [{ path: "lib/index.js" }]
) => {
  const dir = joinPath(root, "modules", moduleId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    joinPath(dir, "manifest.json"),
    JSON.stringify(
      {
        sliceId: `runtime-${moduleId}`,
        version: "0.1.0",
        runtimeApiVersion: "1",
        moduleId,
        entrypoint: "lib/index.js",
        platform: "dev-any",
        artifacts: artifacts.map((artifact) => ({
          path: artifact.path,
          sha256: artifact.sha256 ?? "dev-placeholder",
        })),
      },
      null,
      2
    )
  );
};

const dumpSliceGuardSnapshot = (label: string, ctx: { root?: string | null; errors?: readonly string[] | null }) => {
  try {
    console.error(`=== [slice-packaging-guard:${label}] snapshot ===`);
    console.error(`slicesRoot=${ctx.root ?? "<none>"}`);
    console.error(`errors:\n${JSON.stringify(ctx.errors ?? [], null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("runtime slice packaging guard [slice-packaging-guard]", () => {
  it("accepts current repository slices for cross-app boundary checks", () => {
    const slicesRoot = getDefaultSlicesRoot();
    console.info(`[slice-packaging-guard:repo-slices] validating real slices at ${slicesRoot}`);
    const errors = validateRuntimeSlicePackaging({ slicesRoot });
    try {
      expect(errors).toEqual([]);
    } catch (err) {
      dumpSliceGuardSnapshot("repo-slices-failure", { root: slicesRoot, errors });
      throw err;
    }
  });

  it("accepts shared ffmpeg artifacts in the runtime core slice", () => {
    const root = mkdtempSync(joinPath(tmpdir(), "runtime-slice-core-guard-"));
    console.info(`[slice-packaging-guard:core-ffmpeg] tempRoot=${root}, writing core manifest with tools/ffmpeg+ffprobe`);
    let errors: readonly string[] = [];
    try {
      writeManifest(root, "core", [
        { path: "lib/index.js" },
        { path: "tools/ffmpeg" },
        { path: "tools/ffprobe" },
      ]);
      errors = validateRuntimeSlicePackaging({ slicesRoot: root });
      expect(errors).toEqual([]);
    } catch (err) {
      dumpSliceGuardSnapshot("core-ffmpeg-failure", { root, errors });
      throw err;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects core-only ffmpeg artifacts in non-core slices", () => {
    const root = mkdtempSync(joinPath(tmpdir(), "runtime-slice-guard-"));
    console.info(`[slice-packaging-guard:reject-non-core-ffmpeg] tempRoot=${root}, parrot manifest carries tools/ffmpeg`);
    let errors: readonly string[] = [];
    try {
      writeManifest(root, "parrot", [
        { path: "lib/index.js" },
        { path: "tools/ffmpeg" },
      ]);
      errors = validateRuntimeSlicePackaging({ slicesRoot: root });
      console.info(`[slice-packaging-guard:reject-non-core-ffmpeg] errors=${JSON.stringify(errors)}`);
      expect(errors).toEqual([
        "non-core module parrot includes core-only artifact: tools/ffmpeg",
      ]);
    } catch (err) {
      dumpSliceGuardSnapshot("reject-non-core-ffmpeg-failure", { root, errors });
      throw err;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unexpected module slices for a target app package", () => {
    const root = mkdtempSync(joinPath(tmpdir(), "runtime-slice-app-guard-"));
    console.info(`[slice-packaging-guard:reject-unexpected-module] tempRoot=${root}, targetApp=parrot, modules=[parrot,badger]`);
    let errors: readonly string[] = [];
    try {
      writeManifest(root, "parrot");
      writeManifest(root, "badger");
      errors = validateRuntimeSlicePackaging({
        slicesRoot: root,
        targetApp: "parrot",
      });
      console.info(`[slice-packaging-guard:reject-unexpected-module] errors=${JSON.stringify(errors)}`);
      expect(errors).toEqual(["unexpected module slice for app parrot: badger"]);
    } catch (err) {
      dumpSliceGuardSnapshot("reject-unexpected-module-failure", { root, errors });
      throw err;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
