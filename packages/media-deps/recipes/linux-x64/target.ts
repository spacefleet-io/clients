import type { DepsTarget } from "../../src/target";

const target: DepsTarget = {
  id: "linux-x64",
  kind: "desktop",
  os: "linux",
  arch: "x64",
  nodePlatform: "linux",
  exeSuffix: "",
  builder: "docker",
  dockerPlatform: "linux/amd64",
  sources: [
    "ffmpeg",
    "mpv",
    "x264",
    "x265",
    "lame",
    "dav1d",
    "nvcodec",
    "amf",
    "libvpl",
    "libdrm",
    "wayland",
    "wayland-protocols",
    "libva",
    "libplacebo",
  ],
  ffmpegFlags: [
    "--enable-vaapi", // VA-API: Intel/AMD iGPU + dGPU
    "--enable-ffnvcodec",
    "--enable-nvenc",
    "--enable-nvdec",
    "--enable-cuda-llvm", // scale_cuda without the CUDA toolkit
    "--enable-libvpl", // Intel QSV
    "--enable-amf", // AMD AMF (proprietary driver)
  ],
  hardwareEncoders: ["vaapi", "nvenc", "qsv", "amf"],
  // NVDEC decode feeding the NVENC recipe (`-hwaccel cuda`) and VA-API decode (Intel/AMD, `-hwaccel vaapi`); both back
  // mpv's `--hwdec=auto-safe`. Anything the hardware refuses falls back to software decode.
  ffmpegHwaccels: ["h264_nvdec", "hevc_nvdec", "vp9_nvdec", "av1_nvdec", "h264_vaapi", "hevc_vaapi", "vp9_vaapi", "av1_vaapi"],
  ffmpegRequiredHwaccelMethods: ["vaapi", "cuda"],
  libplaceboMesonOptions: [
    "-Dvulkan=disabled",
    "-Dvk-proc-addr=disabled",
    "-Dopengl=enabled",
    "-Dgl-proc-addr=enabled",
    "-Dd3d11=disabled",
    "-Dglslang=disabled",
    "-Dshaderc=disabled",
    "-Dlcms=disabled",
    "-Ddovi=disabled",
    "-Dlibdovi=disabled",
    "-Ddemos=false",
    "-Dtests=false",
    "-Dbench=false",
    "-Dfuzz=false",
    "-Dunwind=disabled",
    "-Dxxhash=disabled",
  ],
  // GPU path (#25): `--vo=gpu` renders through OpenGL on an EGL context, native on both display servers (MPV-GPU-04):
  // `wayland` (egl-wayland) in a Wayland session, `x11egl` in an X11 one; `--hwdec=auto-safe` decodes through NVDEC
  // (CUDA/GL interop) or VA-API (dmabuf/EGL interop, vaapi-wayland / vaapi-x11). Software GL (llvmpipe) is rejected by
  // mpv's context probe, which then falls through to the CPU vo of the session: `wlshm` (Wayland shared memory) or `x11`.
  // wayland >= 1.21 / wayland-protocols >= 1.31 (mpv 0.41) are built from the pinned forks: the jammy builder has 1.20 / 1.25.
  // Not built: Vulkan (so no `waylandvk`), DRM/KMS outputs (egl-drm, vaapi-drm, gbm, and the `drm` feature need
  // libdisplay-info), legacy GLX and VDPAU.
  mpvMesonOptions: [
    "-Dx11=enabled",
    "-Dx11-clipboard=disabled",
    "-Dalsa=enabled",
    "-Dpulse=enabled",
    "-Doss-audio=disabled",
    "-Dshaderc=disabled",
    "-Dspirv-cross=disabled",
    "-Dgl=enabled",
    "-Degl=enabled",
    "-Degl-x11=enabled",
    "-Dvaapi=enabled",
    "-Dvaapi-x11=enabled",
    "-Dcuda-hwaccel=enabled",
    "-Dcuda-interop=enabled",
    // libdrm must be FOUND: mpv's dmabuf-interop-gl (VA-API surfaces into GL) is `egl and drm.found()`.
    "-Ddrm=auto",
    "-Dgbm=disabled",
    "-Degl-drm=disabled",
    "-Dvaapi-drm=disabled",
    // MPV-GPU-04: a native Wayland window (overrides the shared list's `-Dwayland=disabled`; meson keeps the last -D).
    "-Dwayland=enabled",
    "-Degl-wayland=enabled",
    "-Dvaapi-wayland=enabled",
    "-Ddmabuf-wayland=enabled",
    "-Dvdpau=disabled",
    "-Dvdpau-gl-x11=disabled",
    "-Dplain-gl=disabled",
    "-Dgl-x11=disabled",
    "-Dxv=disabled",
  ],
  mpvRequiredFeatures: [
    "alsa",
    "pulse",
    "x11",
    "gl",
    "egl",
    "egl-x11",
    "vaapi",
    "vaapi-x11",
    "dmabuf-interop-gl",
    "cuda-hwaccel",
    "cuda-interop",
    "wayland",
    "egl-wayland",
    "vaapi-wayland",
    "dmabuf-wayland",
  ],
  mpvRequiredVideoOutputs: ["x11", "wlshm", "dmabuf-wayland"],
  mpvRequiredHwdecs: ["vaapi", "vaapi-copy", "nvdec", "nvdec-copy"],
  mpvRequiredGpuContexts: ["x11egl", "wayland"],
  ipc: "unix-socket",
  // Left to the host, never bundled: glibc; the graphics stack a host GPU driver is part of (GL/GLX/EGL dispatch,
  // libdrm, gbm, Vulkan loader, X11/xcb); and the runtime that driver links (mesa links libstdc++, libgcc_s,
  // expat, zlib). The driver is loaded into mpv from the host, so a bundled copy would shadow the host's.
  // libwayland-client / -cursor / -egl are BUNDLED (our 1.24 build, MPV-GPU-04): mpv built against 1.24 binds
  // wl_compositor v6, and an older host libwayland-client aborts on events its interface tables lack (jammy's 1.20:
  // "interface 'wl_surface' has no event 2", mpv hangs). libwayland-client is backward compatible, so a host EGL driver
  // that links it binds to the copy already loaded.
  // libxkbcommon (mpv's Wayland keyboard) is NEEDED by the app's own Electron, so every host running the app has it.
  // libva stays bundled: drivers are dlopen'd from the host and bind to the libva already loaded (pinned at least at
  // the libva current Mesa is built against, src/sources.ts).
  // Size: the X11 client libraries the app's own Electron loads (it NEEDS libX11, libxcb, libXext, libXfixes,
  // libXrandr; they pull libXrender, libXau, libXdmcp) are on every host that runs the app. libXss / libXpresent
  // are not in that closure and stay bundled.
  // Size: likewise what that Electron NEEDS for audio, IPC and text: libasound, libglib-2.0 and libdbus-1 directly,
  // fontconfig / freetype / harfbuzz / fribidi through gtk-3 / pango / cairo; their sonames are stable across
  // distributions. What only they pull in (pcre, uuid, graphite2, png16, brotli) leaves with them and is NOT globbed
  // (jammy's glib links libpcre.so.3, noble's libpcre2). libpulse is not in that closure (Chromium dlopens it).
  hostLibraries: [
    "ld-linux*",
    "libc.so*",
    "libm.so*",
    "libmvec.so*",
    "libpthread.so*",
    "libdl.so*",
    "librt.so*",
    "libresolv.so*",
    "libutil.so*",
    "libanl.so*",
    "libnsl.so*",
    "libnss_*",
    "libBrokenLocale.so*",
    "libthread_db.so*",
    "libGL*",
    "libOpenGL*",
    "libEGL*",
    "libglapi*",
    "libgbm*",
    "libdrm*",
    "libvulkan*",
    "libxkbcommon.so*",
    "libxcb*",
    "libX11*",
    "libXext*",
    "libXfixes*",
    "libXrandr*",
    "libXrender*",
    "libXau*",
    "libXdmcp*",
    "libxshmfence*",
    "libstdc++*",
    "libgcc_s*",
    "libexpat*",
    "libz.so*",
    "libasound.so*",
    "libglib-2.0.so*",
    "libdbus-1.so*",
    "libfontconfig.so*",
    "libfreetype.so*",
    "libharfbuzz.so*",
    "libfribidi.so*",
  ],
};

export default target;
