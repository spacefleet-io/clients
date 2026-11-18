import type { DepsTarget } from "../../src/target";

// Hardware decode through D3D11VA / DXVA2 for the codecs mpv and ffmpeg play on Windows.
const D3D_CODECS = ["h264", "hevc", "vp9", "av1", "mpeg2", "vc1", "wmv3"] as const;
const d3dHwaccels = D3D_CODECS.flatMap((codec) => [`${codec}_d3d11va`, `${codec}_d3d11va2`, `${codec}_dxva2`]);

const target: DepsTarget = {
  id: "windows-x64",
  kind: "desktop",
  os: "windows",
  arch: "x64",
  nodePlatform: "win32",
  exeSuffix: ".exe",
  // mingw-w64 (UCRT) cross build on a Linux host: the Windows VM only RUNS the result.
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
    "zlib",
    "freetype",
    "harfbuzz",
    "fribidi",
    "libass",
    "zimg",
    "luajit",
    "spirvcross",
    "shaderc",
    "glslang",
    "spirvtools",
    "spirvheaders",
    "libplacebo",
  ],
  ffmpegFlags: [
    "--arch=x86_64",
    "--target-os=mingw32",
    "--cross-prefix=x86_64-w64-mingw32-",
    "--enable-cross-compile",
    "--pkg-config=x86_64-w64-mingw32-pkg-config",
    "--enable-d3d11va",
    "--enable-dxva2",
    "--enable-ffnvcodec",
    "--enable-nvenc",
    "--enable-nvdec",
    "--enable-cuda-llvm",
    "--enable-libvpl", // Intel QSV
    "--enable-amf", // AMD AMF
  ],
  hardwareEncoders: ["qsv", "amf", "nvenc"],
  ffmpegHwaccels: ["h264_nvdec", "hevc_nvdec", "vp9_nvdec", "av1_nvdec", ...d3dHwaccels],
  ffmpegRequiredHwaccelMethods: ["d3d11va", "dxva2", "cuda"],
  libplaceboMesonOptions: [
    "-Dd3d11=enabled",
    "-Dshaderc=enabled",
    "-Dvulkan=disabled",
    "-Dvk-proc-addr=disabled",
    "-Dopengl=enabled",
    "-Dgl-proc-addr=enabled",
    "-Dglslang=disabled",
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
  mpvMesonOptions: [
    "-Dwin32-subsystem=console", // stdout/stderr for the spawner + logs; spawn with windowsHide
    "-Dwin32-smtc=disabled", // needs C++/WinRT, not in mingw-w64
    "-Dd3d11=enabled", // the renderer that works on any adapter incl. WARP (the VM)
    "-Dshaderc=enabled",
    "-Dspirv-cross=enabled",
    "-Dgl=enabled",
    "-Dgl-win32=enabled",
    "-Dgl-dxinterop=disabled",
    "-Degl-angle=disabled",
    "-Dwasapi=enabled",
    "-Dd3d-hwaccel=enabled",
    "-Dd3d9-hwaccel=enabled",
    "-Dvaapi-win32=disabled",
  ],
  mpvRequiredFeatures: ["d3d11", "wasapi", "d3d-hwaccel", "shaderc", "spirv-cross"],
  mpvRequiredVideoOutputs: [],
  // `--vo=gpu` on d3d11 (a WARP adapter is the CPU fallback); `--hwdec=auto-safe` picks D3D11VA, NVDEC or DXVA2 (copy).
  mpvRequiredHwdecs: ["d3d11va", "d3d11va-copy", "dxva2-copy", "nvdec", "nvdec-copy"],
  mpvRequiredGpuContexts: ["d3d11"],
  ipc: "named-pipe",
};

export default target;
