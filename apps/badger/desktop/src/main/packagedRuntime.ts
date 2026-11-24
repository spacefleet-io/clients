import { join } from "node:path";

/** Resolves a bundled binary's absolute path (the platform layer's `binaries.resolve(name, ctx)?.path`). */
export type ResolveBundledBinary = (name: "ffmpeg" | "ffprobe" | "mpv") => string | undefined;

/**
 * Environment the packaged (compiled) runtime binary needs that a source/dev
 * runtime derives from the repo checkout (`apps/runtime/src/config.ts`):
 * - `RUNTIME_SLICES_DIR` points at the manifests shipped in `<resources>/runtime/slices`;
 * - `SF_FFMPEG_PATH` / `SF_FFPROBE_PATH` point at the bundled binaries: the compiled runtime has no
 *   app root of its own, so only the desktop main process can locate `<resources>/deps/bin`.
 * - `SF_MPV_PATH` points at the bundled mpv, which decodes audio for skip detection (META-SKIP-04).
 * - `SF_SUBTITLE_OCR_DIR` points at the subtitle OCR child shipped in `<resources>/runtime/ocr` (PLAY-TRACK-05).
 * An explicit value already on `env` wins.
 *
 * Where the binaries live and the runtime data dir are OS-dependent and come
 * from the desktop platform layer (`@space/desktop-platform`), not from here.
 */
export const buildPackagedRuntimeEnv = (
  env: NodeJS.ProcessEnv,
  resourcesPath: string,
  resolveBinary: ResolveBundledBinary,
): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!env.RUNTIME_SLICES_DIR?.trim()) out.RUNTIME_SLICES_DIR = join(resourcesPath, "runtime", "slices");
  if (!env.SF_SUBTITLE_OCR_DIR?.trim()) out.SF_SUBTITLE_OCR_DIR = join(resourcesPath, "runtime", "ocr");
  if (!env.SF_FFMPEG_PATH?.trim()) {
    const ffmpeg = resolveBinary("ffmpeg");
    if (ffmpeg) out.SF_FFMPEG_PATH = ffmpeg;
  }
  if (!env.SF_FFPROBE_PATH?.trim()) {
    const ffprobe = resolveBinary("ffprobe");
    if (ffprobe) out.SF_FFPROBE_PATH = ffprobe;
  }
  if (!env.SF_MPV_PATH?.trim()) {
    const mpv = resolveBinary("mpv");
    if (mpv) out.SF_MPV_PATH = mpv;
  }
  return out;
};
