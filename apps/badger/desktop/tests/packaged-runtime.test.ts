import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildPackagedRuntimeEnv } from "../src/main/packagedRuntime";

const resources = join("/opt", "SpaceBadger", "resources");

const found = (name: string) => join(resources, "deps", "bin", `${name}.exe`);

describe("packaged runtime spawn env", () => {
  it("points the compiled runtime at the slice manifests and the OCR child shipped beside it", () => {
    expect(buildPackagedRuntimeEnv({}, resources, () => undefined)).toEqual({
      RUNTIME_SLICES_DIR: join(resources, "runtime", "slices"),
      SF_SUBTITLE_OCR_DIR: join(resources, "runtime", "ocr"),
    });
  });

  it("keeps explicit RUNTIME_SLICES_DIR / SF_SUBTITLE_OCR_DIR overrides", () => {
    expect(
      buildPackagedRuntimeEnv({ RUNTIME_SLICES_DIR: "/custom/slices", SF_SUBTITLE_OCR_DIR: "/custom/ocr" }, resources, () => undefined),
    ).toEqual({});
  });

  // @bugfix @regression-proof: the compiled runtime resolves ffmpeg/ffprobe from SF_FFMPEG_PATH/SF_FFPROBE_PATH
  // (it has no app root), so the packaged bundle's paths must be handed to it by the desktop main process.
  it("hands the bundled ffmpeg/ffprobe paths (from the platform layer) to the runtime", () => {
    expect(buildPackagedRuntimeEnv({}, resources, found)).toEqual({
      RUNTIME_SLICES_DIR: join(resources, "runtime", "slices"),
      SF_SUBTITLE_OCR_DIR: join(resources, "runtime", "ocr"),
      SF_FFMPEG_PATH: found("ffmpeg"),
      SF_FFPROBE_PATH: found("ffprobe"),
    });
  });

  it("keeps explicit SF_FFMPEG_PATH / SF_FFPROBE_PATH overrides", () => {
    const env = buildPackagedRuntimeEnv({ SF_FFMPEG_PATH: "/x/ffmpeg", SF_FFPROBE_PATH: "/x/ffprobe" }, resources, found);
    expect(env.SF_FFMPEG_PATH).toBeUndefined();
    expect(env.SF_FFPROBE_PATH).toBeUndefined();
  });
});
