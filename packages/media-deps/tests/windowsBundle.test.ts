import { describe, expect, it } from "vitest";
import { findForeignDlls } from "../src/bundleClosure";

/**
 * Size plan P7 (#25): fl1-9ba280e31f7c shipped 16.08 MB of DLLs next to ffmpeg's own: the shader compilers mpv's
 * Direct3D 11 renderer uses (libshaderc_shared 10.4 MB, libspirv-cross-c-shared 3.2 MB) and the mingw runtime
 * (libstdc++-6, libgcc_s_seh-1, libwinpthread-1). All of them link statically: mpv.exe carries the parts it calls and
 * the ffmpeg DLLs their bit of winpthread, so the bundle holds the three executables and ffmpeg's libraries only.
 */
// `bin/` of the published windows-x64 bundle fl1-9ba280e31f7c.
const PUBLISHED = [
  "avcodec-62.dll",
  "avdevice-62.dll",
  "avfilter-11.dll",
  "avformat-62.dll",
  "avutil-60.dll",
  "ffmpeg.exe",
  "ffprobe.exe",
  "libgcc_s_seh-1.dll",
  "libshaderc_shared.dll",
  "libspirv-cross-c-shared.dll",
  "libstdc++-6.dll",
  "libwinpthread-1.dll",
  "mpv.exe",
  "swresample-6.dll",
  "swscale-9.dll",
];

describe("@regression-proof a windows-x64 bundle ships ffmpeg's own DLLs and nothing else (#25)", () => {
  it("flags the shader compilers and the mingw runtime of fl1-9ba280e31f7c", () => {
    const foreign = findForeignDlls(PUBLISHED);
    console.info(`[media-deps:win] foreign DLLs: ${foreign.join(",")}`);
    expect(foreign).toEqual([
      "libgcc_s_seh-1.dll",
      "libshaderc_shared.dll",
      "libspirv-cross-c-shared.dll",
      "libstdc++-6.dll",
      "libwinpthread-1.dll",
    ]);
  });

  it("accepts ffmpeg's libraries under any major version, any case", () => {
    const names = ["AVCODEC-63.DLL", "avutil-61.dll", "postproc-59.dll", "swscale-10.dll", "mpv.exe", "ffmpeg.exe"];
    expect(findForeignDlls(names)).toEqual([]);
  });

  it("a DLL that only looks like ffmpeg's is foreign", () => {
    expect(findForeignDlls(["avcodec.dll", "libavcodec-62.dll", "avcodec-62.dll.bak", "d3dcompiler_47.dll"])).toEqual([
      "avcodec.dll",
      "libavcodec-62.dll",
      "d3dcompiler_47.dll",
    ]);
  });
});
