import { sep } from "node:path";
import { bundledBinDirs, firstExisting } from "@space/desktop-platform-contract";
import type {
  BinaryLayer,
  BinaryResolveContext,
  BundledBinary,
  Env,
  PlatformArch,
  ResolvedBinary,
} from "@space/desktop-platform-contract";

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

/** `LD_LIBRARY_PATH` with `libDirs` first (deduped); a copy of `env`. */
const withLdLibraryPath = (env: Env, libDirs: readonly string[]): Env => {
  if (libDirs.length === 0) return { ...env };
  const dirs = [...new Set(libDirs)];
  const existing = env.LD_LIBRARY_PATH ? env.LD_LIBRARY_PATH.split(":").filter((dir) => !dirs.includes(dir)) : [];
  return { ...env, LD_LIBRARY_PATH: [...dirs, ...existing].join(":") };
};

export const createLinuxBinaries = (arch: PlatformArch): BinaryLayer => {
  const searchDirs = (ctx: BinaryResolveContext = {}) => bundledBinDirs("linux", arch, ctx);

  const resolveAll = (name: BundledBinary, ctx: BinaryResolveContext = {}): ResolvedBinary[] => {
    const out: ResolvedBinary[] = [];
    const dirs = searchDirs(ctx);
    const found = firstExisting(dirs, name);
    if (found) {
      // `<resources>/deps/bin` is the packaged layout; `vendor/deps/<os>-<arch>/bin` is a checkout's.
      const source = found.dir.includes(`${sep}vendor${sep}deps${sep}`) ? "vendor-deps" : "packaged-deps";
      out.push({ path: found.path, dir: found.dir, libDirs: [found.dir], source });
    }
    return out;
  };

  return {
    executableName: (base) => base,
    searchDirs,
    resolve: (name, ctx) => resolveAll(name, ctx)[0],
    resolveAll,
    withLibraryPath: withLdLibraryPath,
    launchEnv: (binary, env) => withLdLibraryPath(env, binary.libDirs ?? []),
  };
};
