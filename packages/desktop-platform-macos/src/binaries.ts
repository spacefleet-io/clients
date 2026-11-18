import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { bundledBinDirs } from "@space/desktop-platform-contract";
import type { BinaryLayer, BinaryResolveContext, BundledBinary, Env, PlatformArch, ResolvedBinary } from "@space/desktop-platform-contract";

/**
 * The macOS deps bundle (`vendor/deps/macos-<arch>/` in a checkout, `<resources>/deps/` packaged):
 *
 *   bin/ffmpeg  bin/ffprobe  bin/sf-lifeline     executables, LC_RPATH @loader_path/../lib
 *   lib/*.dylib                                   every library they and mpv load (@rpath install names)
 *   Badger Player.app/Contents/MacOS/mpv          mpv wrapped as its own app (MPV-MODEL-03), so its window has
 *                                                 its own name and icon in the Dock and the app switcher
 *
 * Packaging moves the helper app, same name, to `Badger.app/Contents/Helpers/` (nested code must not live in
 * Resources, apps/badger/desktop/scripts/mac-after-pack.mjs), i.e. `<resources>/../Helpers/Badger Player.app`.
 */
export const MPV_HELPER_APP = "Badger Player.app";
export const MPV_HELPER_EXECUTABLE = join(MPV_HELPER_APP, "Contents", "MacOS", "mpv");

/**
 * Fallback search path for dylibs. The bundled executables find their libraries through LC_RPATH, so
 * this is a safety net only. Not DYLD_LIBRARY_PATH: that one wins over every install name by leaf
 * name, so a bundled libz/libiconv would replace the system copy inside Apple frameworks. Setting
 * the fallback replaces dyld's default fallback list, which is kept at the end.
 */
const DYLD_FALLBACK = "DYLD_FALLBACK_LIBRARY_PATH";
const DEFAULT_DYLD_FALLBACK = ["/usr/local/lib", "/usr/lib"];

const withDyldFallbackPath = (env: Env, libDirs: readonly string[]): Env => {
  if (libDirs.length === 0) return { ...env };
  const dirs = [...new Set(libDirs)];
  const existing = env[DYLD_FALLBACK] ? env[DYLD_FALLBACK].split(":").filter(Boolean) : DEFAULT_DYLD_FALLBACK;
  return { ...env, [DYLD_FALLBACK]: [...dirs, ...existing.filter((dir) => !dirs.includes(dir))].join(":") };
};

const sourceOf = (path: string): ResolvedBinary["source"] =>
  path.includes(`${sep}vendor${sep}deps${sep}`) ? "vendor-deps" : "packaged-deps";

/** `<resources>` of a packaged app, from the context (as `bundledBinDirs` derives it). */
const resourcesOf = (ctx: BinaryResolveContext): string | undefined => {
  const appRoot = ctx.appRoot ?? ctx.env?.SF_APP_ROOT?.trim();
  return ctx.resourcesPath ?? (appRoot ? dirname(appRoot) : undefined);
};

export const createMacosBinaries = (arch: PlatformArch): BinaryLayer => {
  const searchDirs = (ctx: BinaryResolveContext = {}) => bundledBinDirs("macos", arch, ctx);

  const resolveAll = (name: BundledBinary, ctx: BinaryResolveContext = {}): ResolvedBinary[] => {
    const candidates: Array<{ path: string; libDir: string }> = [];
    if (name === "mpv") {
      // The packaged helper app sits in Contents/Helpers, its libraries stay in Contents/Resources/deps/lib.
      const resources = resourcesOf(ctx);
      if (resources) {
        candidates.push({ path: join(resources, "..", "Helpers", MPV_HELPER_EXECUTABLE), libDir: join(resources, "deps", "lib") });
      }
      for (const binDir of searchDirs(ctx)) {
        const depsDir = dirname(binDir);
        candidates.push({ path: join(depsDir, MPV_HELPER_EXECUTABLE), libDir: join(depsDir, "lib") });
      }
    } else {
      for (const binDir of searchDirs(ctx)) candidates.push({ path: join(binDir, name), libDir: join(dirname(binDir), "lib") });
    }
    const seen = new Set<string>();
    const out: ResolvedBinary[] = [];
    for (const { path, libDir } of candidates) {
      if (seen.has(path) || !existsSync(path)) continue;
      seen.add(path);
      out.push({ path, dir: dirname(path), libDirs: [libDir], source: sourceOf(path) });
    }
    return out;
  };

  return {
    executableName: (base) => base,
    searchDirs,
    resolve: (name, ctx) => resolveAll(name, ctx)[0],
    resolveAll,
    bundledPath: (name) => (name === "mpv" ? MPV_HELPER_EXECUTABLE : join("bin", name)),
    withLibraryPath: withDyldFallbackPath,
    launchEnv: (binary, env) => withDyldFallbackPath(env, binary.libDirs ?? []),
  };
};
