import { describe, expect, it } from "vitest";
import { dockerBuildArgs, ffmpegConfigureFlags, mpvMesonOptions } from "../src/plan";
import { loadDesktopTarget as loadTarget } from "../src/targets";

/**
 * #25: the app runs mpv with `--vo=gpu,x11 --hwdec=auto-safe` (Linux) / `--vo=gpu --hwdec=auto-safe` (Windows).
 * The linux-x64 bundle fl1-f276664a7bd1 had NO OpenGL context (`--gpu-context=help` = auto only) and NVDEC as its
 * only decoder, so vo=gpu could never initialise and every frame was decoded and drawn on the CPU.
 */
const mesonValues = (options: readonly string[]) => {
  const values: Record<string, string> = {};
  const duplicates: string[] = [];
  for (const option of options) {
    const match = /^-D([^=]+)=(.*)$/.exec(option);
    if (!match) continue;
    if (match[1]! in values) duplicates.push(match[1]!);
    values[match[1]!] = match[2]!;
  }
  return { values, duplicates };
};

describe("@bugfix @regression-proof linux-x64 mpv renders on the GPU and decodes in hardware (#25)", () => {
  it("builds OpenGL via EGL on X11, VA-API (X11 display + dmabuf GL interop) and NVDEC with CUDA/GL interop", async () => {
    const target = await loadTarget("linux-x64");
    const options = mpvMesonOptions(target);
    const { values, duplicates } = mesonValues(options);
    console.info(`[media-deps:gpu] linux-x64 mpv meson options: ${options.join(" ")}`);
    expect(duplicates).toEqual([]);
    for (const feature of ["gl", "egl", "egl-x11", "vaapi", "vaapi-x11", "cuda-hwaccel", "cuda-interop", "x11"]) {
      expect(`${feature}=${values[feature]}`).toBe(`${feature}=enabled`);
    }
    // libdrm is found (headers: dmabuf-interop-gl) while the `drm` feature itself needs libdisplay-info, which is not
    // forked: `auto` builds the interop without vo=drm.
    expect(values.drm).toBe("auto");
    // No Vulkan, no DRM/KMS outputs, no native Wayland (mpv 0.41 needs wayland >= 1.21 / protocols >= 1.31; jammy has
    // 1.20 / 1.25): Wayland sessions run the X11 path through XWayland.
    for (const feature of ["vulkan", "egl-drm", "vaapi-drm", "gbm", "wayland", "egl-wayland", "vaapi-wayland", "dmabuf-wayland"]) {
      expect(`${feature}=${values[feature]}`).toBe(`${feature}=disabled`);
    }
    expect(values.libmpv).toBe("false");
  });

  it("asserts the GPU path in the built binaries: features, hwdecs, GPU contexts, video outputs", async () => {
    const target = await loadTarget("linux-x64");
    console.info(
      `[media-deps:gpu] linux-x64 verify pins: features=${target.mpvRequiredFeatures.join(",")} hwdecs=${target.mpvRequiredHwdecs.join(",")} ` +
        `contexts=${target.mpvRequiredGpuContexts.join(",")} vos=${target.mpvRequiredVideoOutputs.join(",")} ffmpeg=${target.ffmpegRequiredHwaccelMethods.join(",")}`
    );
    expect(target.mpvRequiredFeatures).toEqual(
      expect.arrayContaining(["gl", "egl", "egl-x11", "vaapi", "vaapi-x11", "dmabuf-interop-gl", "cuda-hwaccel", "cuda-interop"])
    );
    expect(target.mpvRequiredHwdecs).toEqual(expect.arrayContaining(["vaapi", "vaapi-copy", "nvdec", "nvdec-copy"]));
    expect(target.mpvRequiredGpuContexts).toEqual(["x11egl"]);
    expect(target.mpvRequiredVideoOutputs).toEqual(expect.arrayContaining(["x11"]));
    expect(target.ffmpegRequiredHwaccelMethods).toEqual(expect.arrayContaining(["vaapi", "cuda"]));
  });

  it("enables the VA-API decode hwaccels next to the NVDEC ones", async () => {
    const target = await loadTarget("linux-x64");
    const flags = ffmpegConfigureFlags(target);
    const hwaccels = flags.filter((flag) => flag.startsWith("--enable-hwaccel="));
    console.info(`[media-deps:gpu] linux-x64 ffmpeg hwaccels: ${hwaccels.join(" ")}`);
    for (const codec of ["h264", "hevc", "vp9", "av1"]) {
      expect(flags).toContain(`--enable-hwaccel=${codec}_vaapi`);
      expect(flags).toContain(`--enable-hwaccel=${codec}_nvdec`);
    }
    expect(flags).toContain("--enable-vaapi");
  });

  it("hands the host-library list to the recipe as a hashed build arg", async () => {
    const target = await loadTarget("linux-x64");
    const args = dockerBuildArgs(target);
    console.info(`[media-deps:gpu] HOST_LIBRARIES=${args.HOST_LIBRARIES}`);
    expect(args.HOST_LIBRARIES).toBe((target.hostLibraries ?? []).join(" "));
    expect(args.HOST_LIBRARIES).toContain("libEGL*");
  });
});

describe("windows-x64 GPU path pins (verify only: the recipe already builds D3D11 + D3D11VA/DXVA2/NVDEC)", () => {
  it("asserts d3d11 rendering and D3D11VA / DXVA2 / NVDEC decode, with the build flags already in the recipe", async () => {
    const target = await loadTarget("windows-x64");
    const { values } = mesonValues(mpvMesonOptions(target));
    console.info(
      `[media-deps:gpu] windows-x64 verify pins: hwdecs=${target.mpvRequiredHwdecs.join(",")} contexts=${target.mpvRequiredGpuContexts.join(",")} ffmpeg=${target.ffmpegRequiredHwaccelMethods.join(",")}`
    );
    expect(values.d3d11).toBe("enabled");
    expect(values["d3d-hwaccel"]).toBe("enabled");
    expect(target.mpvRequiredGpuContexts).toEqual(["d3d11"]);
    expect(target.mpvRequiredHwdecs).toEqual(expect.arrayContaining(["d3d11va", "d3d11va-copy", "dxva2-copy", "nvdec", "nvdec-copy"]));
    expect(target.ffmpegRequiredHwaccelMethods).toEqual(expect.arrayContaining(["d3d11va", "dxva2", "cuda"]));
    const flags = ffmpegConfigureFlags(target);
    expect(flags).toEqual(expect.arrayContaining(["--enable-d3d11va", "--enable-dxva2", "--enable-nvdec", "--enable-hwaccel=h264_d3d11va2", "--enable-hwaccel=h264_dxva2", "--enable-hwaccel=h264_nvdec"]));
    expect(dockerBuildArgs(target)).not.toHaveProperty("HOST_LIBRARIES");
  });
});
