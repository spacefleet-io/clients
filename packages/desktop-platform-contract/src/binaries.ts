import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BinaryResolveContext, PlatformArch, PlatformId } from "./types";

/** `vendor/deps/<os>-<arch>` below a repo root; `bin/` inside holds ffmpeg, ffprobe, mpv (+ their libraries). */
export const depsDirName = (id: PlatformId, arch: PlatformArch) => `${id}-${arch}`;

const ancestors = (start: string, depth: number): string[] => {
  const out: string[] = [];
  let current = start;
  for (let i = 0; i < depth; i += 1) {
    out.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
};

/**
 * The bundled `bin/` directories to search, best first. Packaged builds carry
 * `<resources>/deps/bin` (`deps-manifest.json` sits next to it); a checkout
 * has `vendor/deps/<os>-<arch>/bin` at its root, found by walking up from the
 * app root and the cwd. The layout is owned by the dependency-build pipeline;
 * this is the one reader.
 */
export const bundledBinDirs = (id: PlatformId, arch: PlatformArch, ctx: BinaryResolveContext = {}): string[] => {
  const dirs: string[] = [];
  // Callers without an explicit app root (the packaged app's mpv lookup) leave the hint in SF_APP_ROOT.
  const appRoot = ctx.appRoot ?? ctx.env?.SF_APP_ROOT?.trim();
  const resources = ctx.resourcesPath ?? (appRoot ? dirname(appRoot) : undefined);
  if (ctx.resourcesPath) dirs.push(join(ctx.resourcesPath, "deps", "bin"));
  else if (resources) dirs.push(join(resources, "deps", "bin"));
  const cwd = ctx.cwd ?? process.cwd();
  for (const start of [appRoot, cwd]) {
    if (!start) continue;
    for (const root of ancestors(start, 7)) dirs.push(join(root, "vendor", "deps", depsDirName(id, arch), "bin"));
  }
  return [...new Set(dirs)];
};

/** First `<dir>/<fileName>` that exists. */
export const firstExisting = (dirs: readonly string[], fileName: string): { path: string; dir: string } | undefined => {
  for (const dir of dirs) {
    const path = join(dir, fileName);
    if (existsSync(path)) return { path, dir };
  }
  return undefined;
};
