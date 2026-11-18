/**
 * Which render path mpv ended up on (issue #25 GPU acceleration).
 *
 * The app asks for a GPU video output first and a CPU one last (Linux
 * `--vo=gpu,x11`), and `--hwdec=auto-safe`. mpv falls back on its own: no GPU,
 * a software-only GL (llvmpipe on Xvfb) or a broken driver leave it on the CPU
 * vo, and a codec the GPU cannot decode leaves it on software decode. These
 * helpers read back and describe the result so every launch logs it.
 */
import { getProperty, type MpvSend } from "./properties";

/** Read after the first frame: before that, hwdec-current has no decoder to report on. */
export const MPV_RENDER_PATH_PROPERTIES = ["current-vo", "current-gpu-context", "hwdec-current", "hwdec-interop"] as const;

export type MpvRenderPath = {
  /** `current-vo`: gpu / gpu-next (GPU), x11 (CPU), ...; null when mpv has no vo. */
  vo: string | null;
  /** `current-gpu-context`: x11egl, wayland, d3d11, ...; null on a CPU vo. */
  gpuContext: string | null;
  /** `hwdec-current`: nvdec, vaapi, d3d11va, vaapi-copy, ...; "no" = software decode; null before a decoder exists. */
  hwdec: string | null;
  /** `hwdec-interop`: the GPU interop the vo loaded (cuda, vaapi, d3d11va); null when none. */
  hwdecInterop: string | null;
};

export type MpvRenderClass = {
  rendering: "gpu" | "cpu" | "unknown";
  decoding: "hardware" | "software" | "unknown";
};

/** `mediacodec_embed`: Android TV's direct render, the hardware decoder draws straight into the surface (no CPU copy). */
const GPU_VOS: Record<string, true> = { gpu: true, "gpu-next": true, mediacodec_embed: true };
const isGpuVo = (vo: string): boolean => GPU_VOS[vo] === true;

const nonEmpty = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);

export const readMpvRenderPath = async (send: MpvSend): Promise<MpvRenderPath> => {
  const [vo, gpuContext, hwdec, hwdecInterop] = await Promise.all(MPV_RENDER_PATH_PROPERTIES.map((name) => getProperty(send, name)));
  return { vo: nonEmpty(vo), gpuContext: nonEmpty(gpuContext), hwdec: nonEmpty(hwdec), hwdecInterop: nonEmpty(hwdecInterop) };
};

export type MpvRenderLog = {
  /** The vo of the last `VO: [name]` line (the one that showed frames). */
  vo: string | null;
  /** The GPU the GPU vo rendered on (`GL_RENDERER=` / d3d11 `Device Name:`); null on a CPU vo. */
  renderer: string | null;
  /** Software GL renderers mpv's context probe rejected on the way to the vo it kept (llvmpipe on Xvfb). */
  softwareRejected: string[];
  /** d3d11 created a WARP (software) device: the gpu vo renders on the CPU. */
  softwareAdapter: boolean;
};

/**
 * `log` (from the launch's mpv log file) refines the verdict: a d3d11 WARP
 * device keeps vo=gpu but renders on the CPU (Windows' fallback).
 */
export const classifyMpvRenderPath = (path: MpvRenderPath, log?: MpvRenderLog): MpvRenderClass => ({
  rendering: path.vo === null ? "unknown" : isGpuVo(path.vo) && log?.softwareAdapter !== true ? "gpu" : "cpu",
  decoding: path.hwdec === null ? "unknown" : path.hwdec === "no" ? "software" : "hardware",
});

const describeRejected = (names: string[]): string => {
  const counts: Record<string, number> = {};
  for (const name of names) counts[name] = (counts[name] ?? 0) + 1;
  return Object.entries(counts)
    .map(([name, count]) => `'${name}'${count > 1 ? `x${count}` : ""}`)
    .join(",");
};

export const describeMpvRenderPath = (path: MpvRenderPath, log?: MpvRenderLog): string => {
  const { rendering, decoding } = classifyMpvRenderPath(path, log);
  let raw = `vo=${path.vo ?? "-"} context=${path.gpuContext ?? "-"} hwdec=${path.hwdec ?? "-"} interop=${path.hwdecInterop ?? "-"}`;
  if (log) {
    raw += ` renderer=${log.renderer === null ? "-" : `'${log.renderer}'`}`;
    if (log.softwareRejected.length > 0) raw += ` rejected=${describeRejected(log.softwareRejected)}`;
    if (log.softwareAdapter) raw += " software-adapter";
  }
  return `${rendering} render, ${decoding} decode (${raw})`;
};

const GL_RENDERER = /GL_RENDERER='(.*)'\s*$/;
const D3D11_DEVICE = /\]\s*Device Name: (.*?)\s*$/;
const SOFTWARE_DETECTED = /Detected suspected software renderer\./;
const VO_LINE = /\]\s*VO: \[([^\]]+)\]/;

/**
 * The renderer side of the path, from an mpv `--log-file` (written at -v):
 * properties do not expose the GPU name or the software renderers rejected.
 */
export const parseMpvRenderLog = (log: string): MpvRenderLog => {
  let vo: string | null = null;
  let candidate: string | null = null;
  const softwareRejected: string[] = [];
  let softwareAdapter = false;
  for (const line of log.split(/\r?\n/)) {
    const renderer = GL_RENDERER.exec(line)?.[1] ?? D3D11_DEVICE.exec(line)?.[1];
    if (renderer !== undefined) {
      candidate = renderer;
      continue;
    }
    if (SOFTWARE_DETECTED.test(line) && candidate !== null) {
      softwareRejected.push(candidate);
      candidate = null;
      continue;
    }
    if (line.includes("Using a software adapter")) softwareAdapter = true;
    const shown = VO_LINE.exec(line)?.[1];
    if (shown !== undefined) vo = shown;
  }
  return { vo, renderer: vo !== null && isGpuVo(vo) ? candidate : null, softwareRejected, softwareAdapter };
};

/** The tag of the mobile players' native render-path line (Android `MpvPlaybackReport.kt`, iOS `MpvEngine.reportGpu`). */
export const MPV_GPU_REPORT_TAG = "playback.gpu";

/**
 * One native `playback.gpu hwdec-current=… current-vo=… codec=… WxH [pixfmt=hw/sw]` line, logged in release builds at
 * each file's first playback restart and on every change (MPV-GPU-02). `none` (no decoder / vo yet) reads as null.
 */
export type MpvGpuReport = {
  hwdec: string | null;
  vo: string | null;
  /** `video-format`: hevc, h264, av1, ... */
  codec: string | null;
  width: number | null;
  height: number | null;
  /** iOS only: `video-params/hw-pixelformat` / `video-params/pixelformat`, e.g. `videotoolbox/p010`. */
  pixfmt: string | null;
  /** The verdict, shared with the desktop render-path line. */
  render: MpvRenderClass;
};

const GPU_REPORT_RE = /playback\.gpu hwdec-current=(\S*) current-vo=(\S*) codec=(\S*) (\d*)x(\d*)(?: pixfmt=(\S*))?/;

const reportValue = (value: string | undefined): string | null => (value === undefined || value === "" || value === "none" ? null : value);
const reportSize = (value: string | undefined): number | null => (value ? Number(value) || null : null);

/** The report in a log line (logcat / unified log prefixes allowed); null when the line holds none. */
export const parseMpvGpuReport = (line: string): MpvGpuReport | null => {
  const m = GPU_REPORT_RE.exec(line);
  if (!m) return null;
  const hwdec = reportValue(m[1]);
  const vo = reportValue(m[2]);
  return {
    hwdec,
    vo,
    codec: reportValue(m[3]),
    width: reportSize(m[4]),
    height: reportSize(m[5]),
    pixfmt: reportValue(m[6]),
    render: classifyMpvRenderPath({ vo, gpuContext: null, hwdec, hwdecInterop: null }),
  };
};
