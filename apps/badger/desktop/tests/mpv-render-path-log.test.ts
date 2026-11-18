import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MpvSend } from "@space/mpv-protocol";
import {
  createMpvRenderPathReporter,
  planMpvLaunchLogFile,
  sweepStaleMpvLaunchLogs,
  type MpvLaunchLogFile,
  type MpvLaunchLogFileInput,
  type MpvRenderPathLog,
} from "../src/main/mpvRenderPathLog";

// #25 GPU acceleration: every launch logs, in production too, which render
// path mpv ended up on after its first frame (GPU vo or the CPU fallback,
// hardware or software decode, the GPU it rendered on from the launch's mpv
// log). One line per launch, never a throw.

const sendFrom = (props: Record<string, unknown>) =>
  vi.fn<MpvSend>(async (cmd) => {
    const name = String(cmd.command[1]);
    return name in props ? { data: props[name], error: "success" } : { error: "property unavailable" };
  });

const recorder = () => {
  const lines: Array<{ level: "info" | "warn"; fields: object; msg: string }> = [];
  const log: MpvRenderPathLog = {
    info: (fields, msg) => lines.push({ level: "info", fields, msg }),
    warn: (fields, msg) => lines.push({ level: "warn", fields, msg }),
  };
  return { lines, log };
};

// Verbatim mpv 0.41 log lines (Linux test machine, RTX 5090): XWayland desktop, then Xvfb.
const GPU_LOG = [
  "[   0.016][v][vo/gpu] Probing for best GPU context.",
  "[   0.166][v][vo/gpu/opengl] GL_RENDERER='NVIDIA GeForce RTX 5090/PCIe/SSE2'",
  "[   0.502][i][vd] Using hardware decoding (nvdec).",
  "[   0.513][i][cplayer] VO: [gpu] 1920x1080 cuda[nv12]",
].join("\n");
const XVFB_LOG = [
  "[   0.198][v][vo/gpu/opengl] GL_RENDERER='llvmpipe (LLVM 23.1.1, 256 bits)'",
  "[   0.198][v][vo/gpu/opengl] Detected suspected software renderer.",
  "[   0.829][i][cplayer] VO: [x11] 1920x1080 nv12",
].join("\n");

describe("createMpvRenderPathReporter", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sf-render-path-log-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const logFileWith = (text: string) => {
    const path = join(dir, "mpv.log");
    writeFileSync(path, text);
    return path;
  };

  it("logs the render path and the GPU it rendered on; a repeat report in the same file with the same values adds no line @req MPV-GPU-02", async () => {
    const send = sendFrom({ "current-vo": "gpu", "current-gpu-context": "x11egl", "hwdec-current": "nvdec", "hwdec-interop": "cuda" });
    const { lines, log } = recorder();
    const report = createMpvRenderPathReporter({ send, log, launchId: 7, logFile: logFileWith(GPU_LOG), closeLog: false });
    await report();
    await report();
    console.info(`[render-path-log:once] ${JSON.stringify(lines)} sends=${send.mock.calls.length}`);
    expect(lines).toEqual([
      {
        level: "info",
        fields: {
          launchId: 7,
          vo: "gpu",
          gpuContext: "x11egl",
          hwdec: "nvdec",
          hwdecInterop: "cuda",
          rendering: "gpu",
          decoding: "hardware",
          renderer: "NVIDIA GeForce RTX 5090/PCIe/SSE2",
          softwareRejected: [],
          softwareAdapter: false,
        },
        msg: "mpv render path: gpu render, hardware decode (vo=gpu context=x11egl hwdec=nvdec interop=cuda renderer='NVIDIA GeForce RTX 5090/PCIe/SSE2')",
      },
    ]);
    // Both reports read mpv (4 properties each); the second line is deduped.
    expect(send).toHaveBeenCalledTimes(8);
  });

  // @bugfix mpv-render-path-logged-once-per-launch @regression-proof
  // #448: one mpv process plays the next episode and every Auto-quality
  // reload (`loadfile replace`), and hwdec-current is per file (live mpv
  // 0.41: start-file, file-loaded, playback-restart per loadfile; another
  // codec can fall back to software). The reporter latched once per launch,
  // so no later file's path was logged.
  it("logs again for every file after start-file, with that file's decoder (next episode on the same mpv) @req MPV-GPU-02", async () => {
    const props: Record<string, unknown> = { "current-vo": "gpu", "current-gpu-context": "x11egl", "hwdec-current": "nvdec", "hwdec-interop": "cuda" };
    const send = vi.fn<MpvSend>(async (cmd) => {
      if (cmd.command[0] === "set_property") return { error: "success" };
      const name = String(cmd.command[1]);
      return name in props ? { data: props[name], error: "success" } : { error: "property unavailable" };
    });
    const { lines, log } = recorder();
    const onRenderPath = vi.fn();
    const report = createMpvRenderPathReporter({ send, log, launchId: 11, logFile: logFileWith(GPU_LOG), closeLog: true, onRenderPath });
    console.info("[render-path-log:per-file] phase=episode-1");
    await report();
    report.startFile();
    console.info("[render-path-log:per-file] phase=episode-2 (same values)");
    await report();
    report.startFile();
    props["hwdec-current"] = "no";
    delete props["hwdec-interop"];
    console.info("[render-path-log:per-file] phase=episode-3 (software decode)");
    await report();
    const closes = send.mock.calls.filter(([cmd]) => cmd.command[0] === "set_property").map(([cmd]) => cmd.command);
    console.info(`[render-path-log:per-file] lines=${JSON.stringify(lines)} closes=${JSON.stringify(closes)} onRenderPath=${JSON.stringify(onRenderPath.mock.calls)}`);
    expect(lines.map((l) => [l.level, l.fields])).toEqual([
      ["info", expect.objectContaining({ launchId: 11, hwdec: "nvdec", decoding: "hardware" })],
      ["info", expect.objectContaining({ launchId: 11, hwdec: "nvdec", decoding: "hardware" })],
      ["info", expect.objectContaining({ launchId: 11, hwdec: "no", decoding: "software" })],
    ]);
    // The renderer still comes from the launch's (closed) log for later files.
    expect(lines[2]?.fields).toMatchObject({ renderer: "NVIDIA GeForce RTX 5090/PCIe/SSE2" });
    // Per launch, not per file: the transient log closes once, the GPU memory learns once.
    expect(closes).toEqual([["set_property", "log-file", ""]]);
    expect(onRenderPath).toHaveBeenCalledTimes(1);
  });

  it("logs again in the same file when the path changes (a decoder fallback) @req MPV-GPU-02", async () => {
    const props: Record<string, unknown> = { "current-vo": "gpu", "hwdec-current": "vaapi" };
    const send = vi.fn<MpvSend>(async (cmd) => {
      const name = String(cmd.command[1]);
      return name in props ? { data: props[name], error: "success" } : { error: "property unavailable" };
    });
    const { lines, log } = recorder();
    const report = createMpvRenderPathReporter({ send, log, launchId: 12, logFile: null, closeLog: false });
    await report();
    props["hwdec-current"] = "no";
    await report();
    console.info(`[render-path-log:change] ${JSON.stringify(lines.map((l) => l.msg))}`);
    expect(lines.map((l) => l.fields)).toEqual([
      expect.objectContaining({ hwdec: "vaapi", decoding: "hardware" }),
      expect.objectContaining({ hwdec: "no", decoding: "software" }),
    ]);
  });

  it("logs the CPU fallback with the software renderer mpv rejected @req MPV-GPU-02", async () => {
    const { lines, log } = recorder();
    await createMpvRenderPathReporter({ send: sendFrom({ "current-vo": "x11", "hwdec-current": "no" }), log, launchId: 1, logFile: logFileWith(XVFB_LOG), closeLog: false })();
    console.info(`[render-path-log:cpu] ${JSON.stringify(lines)}`);
    expect(lines[0]?.msg).toBe("mpv render path: cpu render, software decode (vo=x11 context=- hwdec=no interop=- renderer=- rejected='llvmpipe (LLVM 23.1.1, 256 bits)')");
    expect(lines[0]?.fields).toMatchObject({ rendering: "cpu", renderer: null, softwareRejected: ["llvmpipe (LLVM 23.1.1, 256 bits)"] });
  });

  // The GPU probe memory (#25 follow-up) learns from the same first-frame read:
  // the reporter hands it the class and the description it logged, once.
  it("hands the render class and description to onRenderPath once per launch @req MPV-GPU-01", async () => {
    const { log } = recorder();
    const seen: Array<[object, string]> = [];
    const report = createMpvRenderPathReporter({
      send: sendFrom({ "current-vo": "x11", "hwdec-current": "no" }),
      log,
      launchId: 4,
      logFile: logFileWith(XVFB_LOG),
      closeLog: false,
      onRenderPath: (renderClass, description) => seen.push([renderClass, description]),
    });
    await report();
    await report();
    console.info(`[render-path-log:on-render-path] ${JSON.stringify(seen)}`);
    expect(seen).toEqual([
      [{ rendering: "cpu", decoding: "software" }, "cpu render, software decode (vo=x11 context=- hwdec=no interop=- renderer=- rejected='llvmpipe (LLVM 23.1.1, 256 bits)')"],
    ]);
  });

  it("still logs the properties when the mpv log cannot be read (renderer unknown)", async () => {
    const { lines, log } = recorder();
    const send = sendFrom({ "current-vo": "gpu", "current-gpu-context": "d3d11", "hwdec-current": "d3d11va", "hwdec-interop": "d3d11va" });
    await createMpvRenderPathReporter({ send, log, launchId: 2, logFile: join(dir, "missing.log"), closeLog: false })();
    await createMpvRenderPathReporter({ send, log, launchId: 3, logFile: null, closeLog: false })();
    console.info(`[render-path-log:no-log] ${JSON.stringify(lines)}`);
    expect(lines.map((line) => [line.level, line.msg])).toEqual([
      ["info", "mpv render path: gpu render, hardware decode (vo=gpu context=d3d11 hwdec=d3d11va interop=d3d11va)"],
      ["info", "mpv render path: gpu render, hardware decode (vo=gpu context=d3d11 hwdec=d3d11va interop=d3d11va)"],
    ]);
    expect(lines[0]?.fields).toMatchObject({ renderer: null, softwareRejected: [], softwareAdapter: false });
  });

  it("warns instead of throwing when the IPC read fails (mpv gone mid-launch)", async () => {
    const { lines, log } = recorder();
    const send = vi.fn<MpvSend>(async () => {
      throw new Error("socket closed");
    });
    const onRenderPath = vi.fn();
    await expect(createMpvRenderPathReporter({ send, log, launchId: 3, logFile: null, closeLog: true, onRenderPath })()).resolves.toBeUndefined();
    console.info(`[render-path-log:fail] ${JSON.stringify(lines)}`);
    expect(lines).toEqual([{ level: "warn", fields: { launchId: 3, error: "socket closed" }, msg: "mpv render path read failed" }]);
    // Nothing learned from a launch whose path could not be read.
    expect(onRenderPath).not.toHaveBeenCalled();
  });

  // @bugfix mpv-transient-log-written-all-session @regression-proof
  // The transient log exists only for the render-path line, yet mpv kept
  // writing it (always debug level, ~3-6 KB/s) for the whole session. It is
  // closed right after the line is logged. `set_property log-file ""` was
  // checked not to hang mpv 0.41 (#25: Linux NVIDIA 18 runs, Windows d3d11 90
  // runs: IPC answered in <3 ms, playback continued, nothing written after).
  it("closes a transient mpv log once the render path is logged, after reading it @req MPV-GPU-02", async () => {
    const { lines, log } = recorder();
    const props: Record<string, unknown> = { "current-vo": "gpu", "current-gpu-context": "x11egl", "hwdec-current": "nvdec", "hwdec-interop": "cuda" };
    const order: string[] = [];
    const send = vi.fn<MpvSend>(async (cmd) => {
      order.push(cmd.command.map(String).join(" ") + ` (lines=${lines.length})`);
      if (cmd.command[0] === "set_property") return { error: "success" };
      const name = String(cmd.command[1]);
      return name in props ? { data: props[name], error: "success" } : { error: "property unavailable" };
    });
    const report = createMpvRenderPathReporter({ send, log, launchId: 9, logFile: logFileWith(GPU_LOG), closeLog: true });
    await report();
    await report();
    console.info(`[render-path-log:close] order=${JSON.stringify(order)} lines=${JSON.stringify(lines.map((l) => l.msg))}`);
    const closes = send.mock.calls.filter(([cmd]) => cmd.command[0] === "set_property");
    expect(closes.map(([cmd]) => cmd.command)).toEqual([["set_property", "log-file", ""]]);
    // The first report ends with the close; the second (same file, deduped) only reads.
    expect(order[4], "closed only after the render-path line (which needs the log's renderer) was written").toBe("set_property log-file  (lines=1)");
    expect(lines[0]?.fields).toMatchObject({ renderer: "NVIDIA GeForce RTX 5090/PCIe/SSE2" });
  });

  it("never closes a kept (debug) mpv log, and warns when mpv refuses the close", async () => {
    const kept = recorder();
    const keptSend = sendFrom({ "current-vo": "gpu", "hwdec-current": "no" });
    await createMpvRenderPathReporter({ send: keptSend, log: kept.log, launchId: 4, logFile: logFileWith(GPU_LOG), closeLog: false })();
    expect(keptSend.mock.calls.filter(([cmd]) => cmd.command[0] === "set_property")).toEqual([]);

    const refused = recorder();
    const refusedSend = sendFrom({ "current-vo": "gpu", "hwdec-current": "no" });
    await createMpvRenderPathReporter({ send: refusedSend, log: refused.log, launchId: 5, logFile: logFileWith(GPU_LOG), closeLog: true })();
    console.info(`[render-path-log:close-refused] ${JSON.stringify(refused.lines)}`);
    expect(refused.lines.map((l) => [l.level, l.msg])).toEqual([
      ["info", expect.stringMatching(/^mpv render path: /)],
      ["warn", "transient mpv log not closed"],
    ]);
    expect(refused.lines[1]?.fields).toMatchObject({ launchId: 5, logFile: expect.stringMatching(/mpv\.log$/) });
  });
});

// The renderer name, the software GL mpv rejected and a WARP device only show
// in mpv's log, so every launch writes one (production too). Without debug
// logging it is transient: the app deletes it when mpv exits. Its name carries
// the app's pid so a later start can tell an orphan from a live launch.
describe("planMpvLaunchLogFile", () => {
  const cases: Array<[string, MpvLaunchLogFileInput, MpvLaunchLogFile]> = [
    ["production: transient file in tmp, named after the app pid", { shouldLog: false, logFileEnv: undefined, tmp: "/tmp", pid: 4242, now: 42 }, { path: "/tmp/sf-mpv-transient-4242-42.log", keep: false }],
    ["debug/dev: kept", { shouldLog: true, logFileEnv: undefined, tmp: "/tmp", pid: 4242, now: 42 }, { path: "/tmp/sf-mpv-external-42.log", keep: true }],
    ["SF_MPV_EXTERNAL_LOG_FILE: that file, kept", { shouldLog: true, logFileEnv: "/run/e2e/mpv.log", tmp: "/tmp", pid: 4242, now: 42 }, { path: "/run/e2e/mpv.log", keep: true }],
    ["empty SF_MPV_EXTERNAL_LOG_FILE ignored", { shouldLog: false, logFileEnv: "", tmp: "/tmp", pid: 7, now: 1 }, { path: "/tmp/sf-mpv-transient-7-1.log", keep: false }],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => {
      const got = planMpvLaunchLogFile(input);
      console.info(`[render-path-log:plan] ${name} ${JSON.stringify({ input, got })}`);
      expect(got).toEqual(expected);
    });
  }
});

// @bugfix mpv-transient-log-leaks-after-app-crash @regression-proof
// Only mpv's exit handler deleted the transient log: an app crash or kill
// left it behind, forever on Windows (%TEMP% is never cleared). App start
// sweeps the transient logs of app processes that are gone; a live app's
// (this one's current launch, another running instance) and every kept
// debug log stay.
describe("sweepStaleMpvLaunchLogs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sf-render-path-sweep-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes the transient logs of dead app pids, keeps live ones and everything else", async () => {
    const files = [
      "sf-mpv-transient-111-1000.log", // crashed app: removed
      "sf-mpv-transient-111-2000.log", // crashed app, second launch: removed
      "sf-mpv-transient-222-3000.log", // live app (this one / another instance): kept
      "sf-mpv-external-4000.log", // kept debug log: never touched
      "sf-mpv-transient-abc-1.log", // not ours: never touched
      "unrelated.log",
    ];
    for (const name of files) writeFileSync(join(dir, name), "x");
    const { lines, log } = recorder();
    const checked: number[] = [];
    await sweepStaleMpvLaunchLogs({
      tmp: dir,
      isAlive: (pid) => {
        checked.push(pid);
        return pid === 222;
      },
      log,
    });
    const left = readdirSync(dir).sort();
    console.info(`[render-path-log:sweep] left=${JSON.stringify(left)} checked=${JSON.stringify(checked)} lines=${JSON.stringify(lines)}`);
    expect(left).toEqual(["sf-mpv-external-4000.log", "sf-mpv-transient-222-3000.log", "sf-mpv-transient-abc-1.log", "unrelated.log"]);
    expect(lines).toEqual([{ level: "info", fields: { removed: 2, kept: 1 }, msg: "stale transient mpv logs swept" }]);
  });

  it("never throws: a missing tmp dir or a file that cannot be removed only warns", async () => {
    const { lines, log } = recorder();
    await expect(sweepStaleMpvLaunchLogs({ tmp: join(dir, "missing"), isAlive: () => false, log })).resolves.toBeUndefined();
    writeFileSync(join(dir, "sf-mpv-transient-9-1.log"), "x");
    await expect(
      sweepStaleMpvLaunchLogs({
        tmp: dir,
        isAlive: () => false,
        log,
        remove: async () => {
          throw new Error("EBUSY: resource busy or locked");
        },
      })
    ).resolves.toBeUndefined();
    console.info(`[render-path-log:sweep-fail] ${JSON.stringify(lines)} exists=${existsSync(join(dir, "sf-mpv-transient-9-1.log"))}`);
    expect(lines.map((line) => [line.level, line.msg])).toEqual([
      ["warn", "stale transient mpv logs not swept"],
      ["warn", "stale transient mpv log not removed"],
      ["info", "stale transient mpv logs swept"],
    ]);
  });
});
