import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDesktopPlatform } from "@space/desktop-platform";

const BASE_OPTIONS = {
  url: "http://127.0.0.1:3000/playback/hls/test/master.m3u8",
};

// Use absolute file:// URL so vitest can reset the module cache between tests.
// The @space/mpv barrel re-export is handled by Node's native ESM loader
// which does not honour vi.resetModules(). Vitest 4's ESM resolver requires
// a fully-qualified URL for dynamic imports (relative strings no longer
// auto-resolve from the test file or auto-append the .ts extension).
const MPV_EXTERNAL = new URL("../../../../packages/mpv/src/external.ts", import.meta.url).href;

// Dump the full computed mpv arg list on assertion failure. try/catch so a
// dump failure can't mask the real expect().
const dumpMpvArgsSnapshot = (label: string, args: unknown) => {
  try {
    const list = Array.isArray(args) ? (args as string[]) : [];
    console.error(`=== [mpv-args:${label}] snapshot ===`);
    console.error(
      `env: SECS=${String(process.env.SF_MPV_STREAM_CACHE_SECS)} MAX=${String(process.env.SF_MPV_STREAM_CACHE_MAX_BYTES)} BACK=${String(process.env.SF_MPV_STREAM_CACHE_BACK_BYTES)} TOG4IN1=${String(process.env.SF_MPV_ENABLE_TOG4IN1)}`,
    );
    console.error(`args.length=${list.length}`);
    console.error(`args:\n${JSON.stringify(list, null, 2)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("mpv stream cache args", () => {
  const original = {
    secs: process.env.SF_MPV_STREAM_CACHE_SECS,
    max: process.env.SF_MPV_STREAM_CACHE_MAX_BYTES,
    back: process.env.SF_MPV_STREAM_CACHE_BACK_BYTES,
    tog4in1: process.env.SF_MPV_ENABLE_TOG4IN1,
  };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.SF_MPV_STREAM_CACHE_SECS = original.secs;
    process.env.SF_MPV_STREAM_CACHE_MAX_BYTES = original.max;
    process.env.SF_MPV_STREAM_CACHE_BACK_BYTES = original.back;
    process.env.SF_MPV_ENABLE_TOG4IN1 = original.tog4in1;
  });

  it("uses small non-zero cache defaults", async () => {
    console.info("[mpv-args:defaults] clearing cache env vars, importing external.ts");
    delete process.env.SF_MPV_STREAM_CACHE_SECS;
    delete process.env.SF_MPV_STREAM_CACHE_MAX_BYTES;
    delete process.env.SF_MPV_STREAM_CACHE_BACK_BYTES;

    const { buildExternalMpvArgs } = await import(MPV_EXTERNAL);
    const args = buildExternalMpvArgs(BASE_OPTIONS);
    console.info(`[mpv-args:defaults] buildExternalMpvArgs returned ${args.length} args`);
    if (
      !args.includes("--cache=yes") ||
      !args.includes("--cache-secs=16") ||
      !args.includes(`--demuxer-max-bytes=${96 * 1024 * 1024}`) ||
      !args.includes(`--demuxer-max-back-bytes=${16 * 1024 * 1024}`)
    ) {
      dumpMpvArgsSnapshot("defaults", args);
    }
    expect(args).toContain("--cache=yes");
    expect(args).toContain("--cache-secs=16");
    expect(args).toContain(`--demuxer-max-bytes=${96 * 1024 * 1024}`);
    expect(args).toContain(`--demuxer-max-back-bytes=${16 * 1024 * 1024}`);
  });

  it("ends mpv's options before the URL, so a URL is never read as an option", async () => {
    const { buildExternalMpvArgs } = await import(MPV_EXTERNAL);
    const args = buildExternalMpvArgs({ ...BASE_OPTIONS, url: "--script=/tmp/x.lua" });
    expect(args.slice(-2)).toEqual(["--", "--script=/tmp/x.lua"]);
    expect(args.filter((entry: string) => entry === "--script=/tmp/x.lua")).toHaveLength(1);
  });

  it("allows disabling cache via env", async () => {
    console.info("[mpv-args:disable] setting SF_MPV_STREAM_CACHE_SECS=0, importing external.ts");
    process.env.SF_MPV_STREAM_CACHE_SECS = "0";
    const { buildExternalMpvArgs } = await import(MPV_EXTERNAL);
    const args = buildExternalMpvArgs(BASE_OPTIONS);
    const hasCacheSecs = args.some((entry: string) => entry.startsWith("--cache-secs="));
    console.info(`[mpv-args:disable] hasCache=no? ${args.includes("--cache=no")} hasCacheSecs=${hasCacheSecs}`);
    if (!args.includes("--cache=no") || hasCacheSecs) {
      dumpMpvArgsSnapshot("disable", args);
    }
    expect(args).toContain("--cache=no");
    expect(args.some((entry: string) => entry.startsWith("--cache-secs="))).toBe(false);
  });

  it("loads the tog4in1 OSC layer by default @req MPV-OSC-01", async () => {
    console.info("[mpv-args:tog4in1] importing external.ts with default env");
    const { buildExternalMpvArgs } = await import(MPV_EXTERNAL);
    const args = buildExternalMpvArgs(BASE_OPTIONS);
    const hasTog4in1 = args.some((entry: string) => entry.includes("tog4in1.lua"));
    console.info(`[mpv-args:tog4in1] hasTog4in1=${hasTog4in1}`);
    if (!hasTog4in1) {
      dumpMpvArgsSnapshot("tog4in1", args);
    }
    expect(hasTog4in1).toBe(true);
  });

  // MPV-OSC-05: mpv's own OSD text (warnings, osd_message) and text subtitles do not grow or shrink with the window.
  it("keeps mpv's OSD text and subtitles one size whatever the window size @req MPV-OSC-05", async () => {
    const { buildExternalMpvArgs } = await import(MPV_EXTERNAL);
    const args = buildExternalMpvArgs(BASE_OPTIONS);
    const scaleArgs = args.filter((a: string) => /^--(osd|sub)-scale/.test(a));
    console.info(`[mpv-args:osd-scale] scale args=${JSON.stringify(scaleArgs)}`);
    if (!args.includes("--osd-scale-by-window=no") || !args.includes("--sub-scale-by-window=no")) dumpMpvArgsSnapshot("osd-scale", args);
    expect(args).toContain("--osd-scale-by-window=no");
    expect(args).toContain("--sub-scale-by-window=no");
  });

  // #25 GPU acceleration: the platform's GPU-first vo list and mpv's recommended
  // hwdec. No --gpu-context / --gpu-api / --gpu-sw beyond what the platform's
  // mpvWindow names (Linux / Windows: none, only mpv's context *probe* rejects a
  // software renderer such as llvmpipe on Xvfb, an explicit context takes it;
  // macOS: Vulkan through MoltenVK, MPV-GPU-03).
  it("asks for the platform's GPU-first vo list and hwdec=auto-safe, leaving the GPU context to mpv's probe unless the platform names one", async () => {
    const { buildExternalMpvArgs } = await import(MPV_EXTERNAL);
    const renderArg = /^--(vo|hwdec|gpu-[a-z-]+)=/;
    const window = getDesktopPlatform().shell.mpvWindow({ appId: "spacebadger" });
    const expected = [`--vo=${window.defaultVo}`, "--hwdec=auto-safe", ...window.args.filter((entry) => renderArg.test(entry))];
    const args: string[] = buildExternalMpvArgs(BASE_OPTIONS);
    const render = args.filter((entry) => renderArg.test(entry));
    console.info(`[mpv-args:render-path] platform vo=${window.defaultVo} expected=${JSON.stringify(expected)} render args=${JSON.stringify(render)}`);
    if (render.length !== expected.length) dumpMpvArgsSnapshot("render-path", args);
    expect(render).toEqual(expected);

    const overridden: string[] = buildExternalMpvArgs({ ...BASE_OPTIONS, vo: "x11", hwdec: "no" });
    console.info(`[mpv-args:render-path] overridden=${JSON.stringify(overridden.filter((e) => /^--(vo|hwdec)=/.test(e)))}`);
    expect(overridden).toEqual(expect.arrayContaining(["--vo=x11", "--hwdec=no"]));
  });
});

// @req REL-ENV-36[ci]: a lane run or a test launch (SF_SILENT=1) never sends mpv's sound to the sound server; a developer's
// own run (no SF_SILENT) keeps its audio output untouched.
describe("silent mpv (SF_SILENT)", () => {
  const saved = process.env.SF_SILENT;
  afterEach(() => {
    if (saved === undefined) delete process.env.SF_SILENT;
    else process.env.SF_SILENT = saved;
  });

  it("SF_SILENT=1 adds --mute=yes --ao=null after any extra args; unset or 0 adds nothing", async () => {
    const { buildExternalMpvArgs } = await import(MPV_EXTERNAL);
    process.env.SF_SILENT = "1";
    const silent: string[] = buildExternalMpvArgs({ ...BASE_OPTIONS, extraArgs: ["--ao=pulse"] });
    const audio = silent.filter((e) => /^--(ao|mute)=/.test(e));
    console.info(`[mpv-args:silent] SF_SILENT=1 audio args=${JSON.stringify(audio)}`);
    expect(audio).toEqual(["--ao=pulse", "--mute=yes", "--ao=null"]);

    for (const value of [undefined, "0"]) {
      if (value === undefined) delete process.env.SF_SILENT;
      else process.env.SF_SILENT = value;
      const normal: string[] = buildExternalMpvArgs(BASE_OPTIONS);
      const normalAudio = normal.filter((e) => /^--(ao|mute)=/.test(e));
      console.info(`[mpv-args:silent] SF_SILENT=${value ?? "(unset)"} audio args=${JSON.stringify(normalAudio)}`);
      expect(normalAudio).toEqual([]);
    }
  });
});
