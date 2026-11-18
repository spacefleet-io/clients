import { describe, expect, it, vi } from "vitest";

import {
  classifyMpvRenderPath,
  describeMpvRenderPath,
  MPV_RENDER_PATH_PROPERTIES,
  parseMpvRenderLog,
  readMpvRenderPath,
  type MpvRenderClass,
  type MpvRenderPath,
} from "../src/renderPath";
import type { MpvSend } from "../src/properties";

// Issue #25 GPU acceleration: after the first frame the app reads which video
// output, GPU context and hardware decoder mpv actually ended up on (the vo
// list falls back to the CPU one when the GPU is missing or software-only).

const log = (label: string, value: unknown) => console.info(`[render-path:${label}] ${JSON.stringify(value)}`);

const sendFrom = (props: Record<string, unknown>) =>
  vi.fn<MpvSend>(async (cmd) => {
    const name = String(cmd.command[1]);
    return name in props ? { data: props[name], error: "success" } : { error: "property unavailable" };
  });

describe("readMpvRenderPath", () => {
  it("reads the four render-path properties in one pass", async () => {
    const send = sendFrom({ "current-vo": "gpu", "current-gpu-context": "x11egl", "hwdec-current": "nvdec", "hwdec-interop": "cuda" });
    const path = await readMpvRenderPath(send);
    log("gpu", { path, calls: send.mock.calls });
    expect(path).toEqual({ vo: "gpu", gpuContext: "x11egl", hwdec: "nvdec", hwdecInterop: "cuda" });
    expect(send.mock.calls.map(([cmd]) => cmd.command[1])).toEqual([...MPV_RENDER_PATH_PROPERTIES]);
  });

  it("maps unavailable properties to null (CPU vo has no GPU context, no decoder yet)", async () => {
    const send = sendFrom({ "current-vo": "x11", "hwdec-current": "no" });
    const path = await readMpvRenderPath(send);
    log("cpu", path);
    expect(path).toEqual({ vo: "x11", gpuContext: null, hwdec: "no", hwdecInterop: null });
  });

  it("maps empty strings to null (mpv reports an unset interop as empty)", async () => {
    const path = await readMpvRenderPath(sendFrom({ "current-vo": "gpu", "current-gpu-context": "d3d11", "hwdec-current": "d3d11va", "hwdec-interop": "" }));
    log("empty", path);
    expect(path.hwdecInterop).toBeNull();
  });
});

describe("classifyMpvRenderPath", () => {
  const cases: Array<[string, MpvRenderPath, MpvRenderClass]> = [
    ["nvidia linux", { vo: "gpu", gpuContext: "x11egl", hwdec: "nvdec", hwdecInterop: "cuda" }, { rendering: "gpu", decoding: "hardware" }],
    ["windows d3d11", { vo: "gpu", gpuContext: "d3d11", hwdec: "d3d11va", hwdecInterop: "d3d11va" }, { rendering: "gpu", decoding: "hardware" }],
    ["gpu-next", { vo: "gpu-next", gpuContext: "x11egl", hwdec: "no", hwdecInterop: null }, { rendering: "gpu", decoding: "software" }],
    ["xvfb fallback", { vo: "x11", gpuContext: null, hwdec: "no", hwdecInterop: null }, { rendering: "cpu", decoding: "software" }],
    ["cpu vo, copy-back decode", { vo: "x11", gpuContext: null, hwdec: "vaapi-copy", hwdecInterop: null }, { rendering: "cpu", decoding: "hardware" }],
    ["no decoder yet", { vo: "gpu", gpuContext: "x11egl", hwdec: null, hwdecInterop: null }, { rendering: "gpu", decoding: "unknown" }],
    ["mpv gone", { vo: null, gpuContext: null, hwdec: null, hwdecInterop: null }, { rendering: "unknown", decoding: "unknown" }],
  ];
  for (const [name, path, expected] of cases) {
    it(name, () => {
      const got = classifyMpvRenderPath(path);
      log(`classify:${name}`, { path, got });
      expect(got).toEqual(expected);
    });
  }

  // A d3d11 WARP device is mpv's Windows CPU fallback: the vo is still "gpu",
  // only the log tells it renders on the CPU.
  it("windows WARP (software adapter in the log) renders on the CPU", () => {
    const path: MpvRenderPath = { vo: "gpu", gpuContext: "d3d11", hwdec: "no", hwdecInterop: null };
    const warp = { vo: "gpu", renderer: "Microsoft Basic Render Driver", softwareRejected: [], softwareAdapter: true };
    const got = classifyMpvRenderPath(path, warp);
    log("classify:warp", { path, warp, got });
    expect(got).toEqual({ rendering: "cpu", decoding: "software" });
    expect(classifyMpvRenderPath(path, { ...warp, renderer: "NVIDIA GeForce RTX 5090", softwareAdapter: false })).toEqual({ rendering: "gpu", decoding: "software" });
  });
});

describe("describeMpvRenderPath", () => {
  it("is one grep-able line with the raw values and the verdict", () => {
    const line = describeMpvRenderPath({ vo: "gpu", gpuContext: "x11egl", hwdec: "nvdec", hwdecInterop: "cuda" });
    log("describe", line);
    expect(line).toBe("gpu render, hardware decode (vo=gpu context=x11egl hwdec=nvdec interop=cuda)");
    expect(describeMpvRenderPath({ vo: "x11", gpuContext: null, hwdec: "no", hwdecInterop: null })).toBe(
      "cpu render, software decode (vo=x11 context=- hwdec=no interop=-)"
    );
  });

  it("adds the renderer, the rejected software renderers and a WARP flag when the mpv log is known", () => {
    const gpu = describeMpvRenderPath(
      { vo: "gpu", gpuContext: "x11egl", hwdec: "nvdec", hwdecInterop: "cuda" },
      { vo: "gpu", renderer: "NVIDIA GeForce RTX 5090/PCIe/SSE2", softwareRejected: [], softwareAdapter: false }
    );
    const fallback = describeMpvRenderPath(
      { vo: "x11", gpuContext: null, hwdec: "no", hwdecInterop: null },
      { vo: "x11", renderer: null, softwareRejected: ["llvmpipe (LLVM 23.1.1, 256 bits)", "llvmpipe (LLVM 23.1.1, 256 bits)"], softwareAdapter: false }
    );
    const warp = describeMpvRenderPath(
      { vo: "gpu", gpuContext: "d3d11", hwdec: "no", hwdecInterop: null },
      { vo: "gpu", renderer: "Microsoft Basic Render Driver", softwareRejected: [], softwareAdapter: true }
    );
    log("describe:log", { gpu, fallback, warp });
    expect(gpu).toBe("gpu render, hardware decode (vo=gpu context=x11egl hwdec=nvdec interop=cuda renderer='NVIDIA GeForce RTX 5090/PCIe/SSE2')");
    expect(fallback).toBe(
      "cpu render, software decode (vo=x11 context=- hwdec=no interop=- renderer=- rejected='llvmpipe (LLVM 23.1.1, 256 bits)'x2)"
    );
    expect(warp).toBe("cpu render, software decode (vo=gpu context=d3d11 hwdec=no interop=- renderer='Microsoft Basic Render Driver' software-adapter)");
  });
});

describe("parseMpvRenderLog", () => {
  // Verbatim lines from mpv 0.41 log files (a Linux test machine, RTX 5090): XWayland desktop, then Xvfb.
  const gpuDesktop = [
    "[   0.016][v][vo/gpu] Probing for best GPU context.",
    "[   0.016][v][vo/gpu/opengl] Initializing GPU context 'x11egl'",
    "[   0.166][v][vo/gpu/opengl] GL_RENDERER='NVIDIA GeForce RTX 5090/PCIe/SSE2'",
    "[   0.502][i][vd] Using hardware decoding (nvdec).",
    "[   0.513][i][cplayer] VO: [gpu] 1920x1080 cuda[nv12]",
  ].join("\n");
  const xvfbFallback = [
    "[   0.014][v][vo/gpu] Probing for best GPU context.",
    "[   0.014][v][vo/gpu/opengl] Initializing GPU context 'x11egl'",
    "[   0.198][v][vo/gpu/opengl] GL_RENDERER='llvmpipe (LLVM 23.1.1, 256 bits)'",
    "[   0.198][v][vo/gpu/opengl] Detected suspected software renderer.",
    "[   0.198][w][vo/gpu/opengl] Suspected software renderer or indirect context.",
    "[   0.829][i][cplayer] VO: [x11] 1920x1080 nv12",
  ].join("\n");
  // d3d11_helpers.c: "Device Name:" at -v, "Using a software adapter" warning for WARP.
  const windowsWarp = [
    "[   0.040][v][vo/gpu/d3d11] Device Name: Microsoft Basic Render Driver",
    "[   0.040][v][vo/gpu/d3d11] Device ID: 1414:008c (rev 00)",
    "[   0.041][w][vo/gpu/d3d11] Using a software adapter",
    "[   0.300][i][cplayer] VO: [gpu] 1920x1080 yuv420p",
  ].join("\r\n");

  it("names the GPU the gpu vo rendered on", () => {
    const got = parseMpvRenderLog(gpuDesktop);
    log("log:gpu", got);
    expect(got).toEqual({ vo: "gpu", renderer: "NVIDIA GeForce RTX 5090/PCIe/SSE2", softwareRejected: [], softwareAdapter: false });
  });

  it("records the software renderers mpv rejected before falling back to the CPU vo", () => {
    const got = parseMpvRenderLog(xvfbFallback);
    log("log:xvfb", got);
    expect(got).toEqual({ vo: "x11", renderer: null, softwareRejected: ["llvmpipe (LLVM 23.1.1, 256 bits)"], softwareAdapter: false });
  });

  it("flags a d3d11 WARP software adapter", () => {
    const got = parseMpvRenderLog(windowsWarp);
    log("log:warp", got);
    expect(got).toEqual({ vo: "gpu", renderer: "Microsoft Basic Render Driver", softwareRejected: [], softwareAdapter: true });
  });

  it("is empty for a log without a VO line", () => {
    expect(parseMpvRenderLog("")).toEqual({ vo: null, renderer: null, softwareRejected: [], softwareAdapter: false });
  });
});
