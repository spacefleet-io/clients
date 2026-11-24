import { existsSync } from "node:fs";
import { join as joinPath, resolve as resolvePath } from "node:path";
import { getDesktopPlatform } from "@space/desktop-platform";

const resolveBinaryEnv = (envName: "SF_FFMPEG_PATH" | "SF_FFPROBE_PATH") => {
  const raw = process.env[envName]?.trim();
  if (!raw || raw === "undefined" || raw === "null") return undefined;
  return raw;
};

const collectSearchRoots = () => {
  const cwd = process.cwd();
  const roots = new Set<string>([cwd, resolvePath(cwd, ".."), resolvePath(cwd, "..", "..")]);
  return Array.from(roots);
};

const resolveBundledBinary = (filename: "ffmpeg" | "ffprobe") => {
  const envName = filename === "ffmpeg" ? "SF_FFMPEG_PATH" : "SF_FFPROBE_PATH";
  const fromEnv = resolveBinaryEnv(envName);
  if (fromEnv) return fromEnv;

  const bundled = getDesktopPlatform().binaries.resolve(filename, { env: process.env });
  if (bundled) return bundled.path;

  const candidates: string[] = [];
  for (const root of collectSearchRoots()) {
    candidates.push(joinPath(root, "slices", "core", "tools", filename));
    candidates.push(joinPath(root, "apps", "runtime", "slices", "core", "tools", filename));
    candidates.push(joinPath(root, "packages", "ffmpeg", "vendor", "ffmpeg", filename));
  }

  return candidates.find((candidate) => existsSync(candidate));
};

export const resolveRuntimeFfmpegPath = () => resolveBundledBinary("ffmpeg");

export const resolveRuntimeFfprobePath = () => resolveBundledBinary("ffprobe");

/**
 * The bundled mpv, which decodes the audio for shared-audio skip detection (META-SKIP-04): `SF_MPV_PATH` (set by
 * the desktop for the packaged runtime), else the platform layer's media-deps bundle; undefined when neither has it.
 */
export const resolveRuntimeMpvPath = (): string | undefined => {
  const raw = process.env.SF_MPV_PATH?.trim();
  if (raw && raw !== "undefined" && raw !== "null") return raw;
  return getDesktopPlatform().binaries.resolve("mpv", { env: process.env, cwd: process.cwd() })?.path;
};
