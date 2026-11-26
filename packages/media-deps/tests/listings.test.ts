import { describe, expect, it } from "vitest";
import { findBundledHostLibraries } from "../src/hostLibraries";
import { missingEntries, parseFfmpegHwaccels, parseMpvHwdecHelp, parseMpvObjectHelp } from "../src/listings";
import { loadDesktopTarget as loadTarget } from "../src/targets";

// Verbatim outputs of the published linux-x64 bundle fl1-f276664a7bd1 (mpv 0.41.0, ffmpeg 8.1.3):
// no GPU context compiled in and NVDEC as the only hardware decoder (#25).
const HWDEC_HELP_NVDEC_ONLY = `Valid values (with alternative full names):
  nvdec (h264-nvdec)
  nvdec (hevc-nvdec)
  nvdec (vp9-nvdec)
  nvdec (av1-nvdec)
  nvdec-copy (h264-nvdec-copy)
  nvdec-copy (hevc-nvdec-copy)
  nvdec-copy (vp9-nvdec-copy)
  nvdec-copy (av1-nvdec-copy)
  auto (yes '')
  no
  auto-safe
  auto-copy
  auto-unsafe
  auto-copy-safe
  auto-copy-unsafe
`;
const GPU_CONTEXT_HELP_NONE = `Available GPU contexts:
  auto             Auto detect

`;
const VO_HELP = `Available video outputs:
  gpu-next         Video output based on libplacebo
  gpu              Shader-based GPU Renderer
  x11              X11 (software scaling)
  libmpv           render API for libmpv
  null             Null video output
  image            Write video frames to image files
  tct              true-color terminals
  kitty            Kitty terminal graphics protocol

`;
const FFMPEG_HWACCELS = `Hardware acceleration methods:
cuda
vaapi
qsv
amf

`;
// Same printers (vd_lavc.c hwdec_opt_help, m_option.c obj list help) once VA-API and EGL/X11 are compiled in.
const HWDEC_HELP_GPU = `Valid values (with alternative full names):
  nvdec (h264-nvdec)
  vaapi (h264-vaapi)
  vaapi (hevc-vaapi)
  nvdec-copy (h264-nvdec-copy)
  vaapi-copy (h264-vaapi-copy)
  auto (yes '')
  no
  auto-safe
`;
const GPU_CONTEXT_HELP_X11EGL = `Available GPU contexts:
  auto             Auto detect
  x11egl           X11/EGL

`;

describe("mpv / ffmpeg availability listings", () => {
  it("reads the hwdec methods of `mpv --hwdec=help`", () => {
    const methods = parseMpvHwdecHelp(HWDEC_HELP_NVDEC_ONLY);
    console.info(`[media-deps:listings] hwdecs (nvdec-only bundle): ${[...methods].join(",")}`);
    expect(methods).toEqual(new Set(["nvdec", "nvdec-copy", "auto", "no", "auto-safe", "auto-copy", "auto-unsafe", "auto-copy-safe", "auto-copy-unsafe"]));
    expect(missingEntries(["vaapi", "vaapi-copy", "nvdec", "nvdec-copy"], methods)).toEqual(["vaapi", "vaapi-copy"]);
    expect(missingEntries(["vaapi", "vaapi-copy", "nvdec", "nvdec-copy"], parseMpvHwdecHelp(HWDEC_HELP_GPU))).toEqual([]);
  });

  it("reads the entry names of an mpv object list (`--gpu-context=help`, `--vo=help`)", () => {
    const none = parseMpvObjectHelp(GPU_CONTEXT_HELP_NONE);
    console.info(`[media-deps:listings] gpu contexts (no-GL bundle): ${[...none].join(",")}`);
    expect(none).toEqual(new Set(["auto"]));
    expect(missingEntries(["x11egl"], none)).toEqual(["x11egl"]);
    expect(parseMpvObjectHelp(GPU_CONTEXT_HELP_X11EGL)).toEqual(new Set(["auto", "x11egl"]));
    expect(parseMpvObjectHelp(VO_HELP)).toEqual(new Set(["gpu-next", "gpu", "x11", "libmpv", "null", "image", "tct", "kitty"]));
  });

  it("reads the device types of `ffmpeg -hwaccels`", () => {
    const methods = parseFfmpegHwaccels(FFMPEG_HWACCELS);
    console.info(`[media-deps:listings] ffmpeg hwaccel methods: ${[...methods].join(",")}`);
    expect(methods).toEqual(new Set(["cuda", "vaapi", "qsv", "amf"]));
    expect(missingEntries(["vaapi", "cuda", "d3d11va"], methods)).toEqual(["d3d11va"]);
  });
});

describe("@bugfix @regression-proof host libraries never ride in the linux-x64 bundle (#25)", () => {
  // The bundle file list of fl1-f276664a7bd1 (abridged): it carried the host-stack libraries a host GPU driver
  // shares with the process (libdrm, libX11/libxcb, libstdc++, libexpat, libz), so the driver bound to our
  // jammy copies instead of the host's.
  const PUBLISHED_FILES = [
    "ffmpeg", "ffprobe", "mpv",
    "libX11-xcb.so.1", "libX11.so.6", "libXau.so.6", "libXext.so.6", "libXpresent.so.1", "libXrandr.so.2",
    "libavcodec.so.62", "libdrm.so.2", "libexpat.so.1", "libgcc_s.so.1", "libplacebo.so.360", "libpulsecommon-15.99.so",
    "libstdc++.so.6", "libva-drm.so.2", "libva.so.2", "libxcb.so.1", "libz.so.1", "libzimg.so.2", "libzstd.so.1",
  ];

  it("flags every glibc, graphics-stack and driver-runtime library and nothing the bundle must carry", async () => {
    const target = await loadTarget("linux-x64");
    const patterns = target.hostLibraries ?? [];
    console.info(`[media-deps:host-libs] patterns: ${patterns.join(" ")}`);
    const flagged = findBundledHostLibraries(PUBLISHED_FILES, patterns);
    console.info(`[media-deps:host-libs] flagged in the published bundle: ${flagged.join(",")}`);
    expect(flagged).toEqual([
      "libX11-xcb.so.1", "libX11.so.6", "libXau.so.6", "libXext.so.6", "libXrandr.so.2",
      "libdrm.so.2", "libexpat.so.1", "libgcc_s.so.1", "libstdc++.so.6", "libxcb.so.1", "libz.so.1",
    ]);
    const hostStack = [
      "libGL.so.1", "libGLX.so.0", "libGLX_mesa.so.0", "libGLdispatch.so.0", "libGLESv2.so.2", "libOpenGL.so.0", "libEGL.so.1",
      "libEGL_mesa.so.0", "libglapi.so.0", "libgbm.so.1", "libdrm.so.2", "libdrm_amdgpu.so.1", "libvulkan.so.1",
      "libxkbcommon.so.0", "libxcb-dri3.so.0", "libxcb-present.so.0", "libxshmfence.so.1",
      "libc.so.6", "libm.so.6", "ld-linux-x86-64.so.2", "libpthread.so.0", "libnss_files.so.2",
    ];
    expect(findBundledHostLibraries(hostStack, patterns)).toEqual(hostStack);
    // libva stays bundled: drivers bind to the libva already loaded (it must be at least the host Mesa's libva).
    // libwayland too (MPV-GPU-04): a host older than the 1.24 mpv is built against aborts on its wl_surface v6 events.
    const bundled = ["libva.so.2", "libva-x11.so.2", "libva-drm.so.2", "libva-wayland.so.2", "libwayland-client.so.0", "libwayland-cursor.so.0", "libwayland-egl.so.1", "libffi.so.8", "libzimg.so.2", "libzstd.so.1"];
    expect(findBundledHostLibraries(bundled, patterns)).toEqual([]);
  });

  // Size (#25): every X11 client library the app's own Electron loads is on any host that runs the app, so the
  // bundle leaves it there too. Electron (linux-x64) NEEDS libX11, libxcb, libXext, libXfixes and libXrandr, which
  // pull libXrender, libXau and libXdmcp. libXss and libXpresent are not in that closure: they stay bundled.
  it("leaves the X11 client libraries Electron loads to the host, keeps the ones it does not", async () => {
    const patterns = (await loadTarget("linux-x64")).hostLibraries ?? [];
    const electronX11 = ["libX11.so.6", "libxcb.so.1", "libXext.so.6", "libXfixes.so.3", "libXrandr.so.2", "libXrender.so.1", "libXau.so.6", "libXdmcp.so.6"];
    expect(findBundledHostLibraries(electronX11, patterns)).toEqual(electronX11);
    expect(findBundledHostLibraries(["libXss.so.1", "libXpresent.so.1"], patterns)).toEqual([]);
  });

  it("the windows-x64 target declares no host libraries (its build args stay as they were)", async () => {
    const target = await loadTarget("windows-x64");
    expect(target.hostLibraries).toBeUndefined();
  });
});
