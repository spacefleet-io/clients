import { bundledBinDirs, firstExisting } from "@space/desktop-platform-contract";
import type { BinaryLayer, BinaryResolveContext, BundledBinary, Env, PlatformArch, ResolvedBinary } from "@space/desktop-platform-contract";
import { findEnvKey } from "./env";

/** `mpv` -> `mpv.exe`; a name that already ends in `.exe` (any case) is returned unchanged. */
export const executableName = (base: string): string => (base.toLowerCase().endsWith(".exe") ? base : `${base}.exe`);

const normalizeDir = (dir: string): string => dir.replace(/[\\/]+$/, "").toLowerCase();

/**
 * `env` with `dirs` first on `PATH` (deduped, case-insensitively, against the
 * existing entries too). The existing key is found ignoring case (`Path` is the
 * usual spelling on Windows) and reused, so the child never sees two spellings.
 * Returns a copy; `env` is never mutated.
 */
export const withWindowsPath = (env: Env, dirs: readonly string[]): Env => {
  if (dirs.length === 0) return { ...env };
  const key = findEnvKey(env, "PATH") ?? "PATH";
  const wanted: string[] = [];
  for (const dir of dirs) {
    if (dir && !wanted.some((seen) => normalizeDir(seen) === normalizeDir(dir))) wanted.push(dir);
  }
  const existing = (env[key] ?? "")
    .split(";")
    .filter((entry) => entry.length > 0 && !wanted.some((dir) => normalizeDir(dir) === normalizeDir(entry)));
  return { ...env, [key]: [...wanted, ...existing].join(";") };
};

/** Checkout layout (`vendor\deps\<os>-<arch>\bin`) versus packaged (`<resources>\deps\bin`). */
const sourceOf = (dir: string): ResolvedBinary["source"] => (/[\\/]vendor[\\/]deps[\\/]/.test(dir) ? "vendor-deps" : "packaged-deps");

export const createWindowsBinaries = (arch: PlatformArch): BinaryLayer => {
  const searchDirs = (ctx: BinaryResolveContext = {}) => bundledBinDirs("windows", arch, ctx);

  // Windows ships ONE layout (the media-deps bundle): no legacy lookups.
  const resolveAll = (name: BundledBinary, ctx: BinaryResolveContext = {}): ResolvedBinary[] => {
    const found = firstExisting(searchDirs(ctx), executableName(name));
    if (!found) return [];
    return [{ path: found.path, dir: found.dir, libDirs: [found.dir], source: sourceOf(found.dir) }];
  };

  return {
    executableName,
    searchDirs,
    resolve: (name, ctx) => resolveAll(name, ctx)[0],
    resolveAll,
    withLibraryPath: withWindowsPath,
    launchEnv: (binary, env) => withWindowsPath(env, binary.libDirs ?? []),
  };
};
