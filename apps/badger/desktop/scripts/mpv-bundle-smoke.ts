// LINUX-DEV-ONLY (intentionally outside the platform layer): it drives Xvfb and x11grab, which have no Windows equivalent.
// Real-binary smoke for the shipped Linux media-deps bundle (#25 P5/P13, #248).
// @bugfix mpv-bundle-private-glibc-and-throttled-mid-segment-seek @regression-proof
//
// Proves, on THIS host, with the app's own launch args and loadfile command:
//   1. the bundle's bin/ carries no private glibc and `mpv --version` starts
//      (a bundled libc.so.6 died on glibc 2.44: undefined symbol
//      __nptl_change_stack_perm) and it is built on FFmpeg >= 8;
//   2. the play-time backdrop renders: mpv launched on a local jpeg shows it
//      (x11grab of the Xvfb screen; pixel check + PNG kept as evidence);
//   3. the backdrop → HLS handoff with a mid-segment `start=` reaches
//      `playback-restart`, and a mid-segment seek restarts too, over a link
//      paced by the app's playbackThrottle (FFmpeg 7.1.1 never restarted:
//      19/19 throttled start>0 failures on the ultimate run).
//
// Usage (repo root; needs Xvfb + a system ffmpeg with x11grab):
//   bun scripts/fetch-deps.ts --target linux-x64   # once
//   bun apps/badger/desktop/scripts/mpv-bundle-smoke.ts [--bundle <vendor/deps/linux-x64>]
//     [--out <evidence dir>] [--kbps 6000]
// Exit 0 = every check passed; any failure prints a state dump and exits 1.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildExternalMpvArgs, buildExternalMpvTargetEnv, planMpvBundleFontCacheWarmup } from "@space/mpv";
import { buildLoadfileCommand } from "@space/mpv-protocol";
import { createPlaybackThrottle } from "../src/main/playbackThrottle";

const TAG = "[mpv-bundle-smoke]";
const log = (msg: string, extra?: unknown) =>
  console.info(`${TAG} ${new Date().toISOString()} ${msg}${extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);

const argValue = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const repoRoot = path.resolve(import.meta.dir, "../../../..");
const bundleDir = path.resolve(argValue("--bundle") ?? path.join(repoRoot, "vendor/deps/linux-x64"));
const outDir = path.resolve(argValue("--out") ?? path.join(tmpdir(), `sf-mpv-bundle-smoke-${Date.now()}`));
const kbps = Number(argValue("--kbps") ?? "6000");
const FIXTURE_DIR = path.join(tmpdir(), "sf-mpv-bundle-smoke-fixture-v1");
// Backdrop colour: anything but black (the bug showed a black window).
const BACKDROP_RGB: [number, number, number] = [0x2e, 0x8b, 0x57];
// Both land mid-segment (6 s segments, 4 s GOP), like the ultimate resumes.
const START_SECONDS = 20.65;
const SEEK_SECONDS = 63.3;
const RESTART_TIMEOUT_MS = 10_000;

const failures: string[] = [];
const check = (ok: boolean, label: string, detail?: unknown) => {
  log(`${ok ? "PASS" : "FAIL"} ${label}`, detail);
  if (!ok) failures.push(label);
  return ok;
};

const mpvBin = path.join(bundleDir, "bin", "mpv");
const mpvLib = path.join(bundleDir, "bin");
// The libc family a bundle must never carry (same set as media-deps verify).
const PRIVATE_GLIBC = [/^libc\.so/, /^libm\.so/, /^ld-linux/, /^libpthread\.so/, /^libdl\.so/, /^librt\.so/];
const mpvCommand = (args: string[]): [string, string[]] => [mpvBin, args];
// Same env the app builds, on a COLD font cache: a fresh XDG_CACHE_HOME and
// data dir per run, like a first launch on a new machine. Then the same
// font-cache warm-up the app runs at startup (off the play path).
// `--no-font-warmup` skips it to reproduce the cold system-font scan before
// the first frame (#25 P5/B3 "before" number).
const skipFontWarmup = process.argv.includes("--no-font-warmup");
const coldCacheDir = path.join(outDir, "xdg-cache");
const mpvDataDir = path.join(outDir, "mpv-data");
rmSync(coldCacheDir, { recursive: true, force: true });
rmSync(mpvDataDir, { recursive: true, force: true });
mkdirSync(coldCacheDir, { recursive: true });
mkdirSync(mpvDataDir, { recursive: true });
const bundleTarget = { bin: mpvBin, kind: "bundle" as const, libDirs: [mpvLib] };
const mpvEnv: NodeJS.ProcessEnv = buildExternalMpvTargetEnv(bundleTarget, {
  env: { ...process.env, XDG_CACHE_HOME: coldCacheDir },
});
log("mpv env", { XDG_CACHE_HOME: coldCacheDir, LD_LIBRARY_PATH: mpvEnv.LD_LIBRARY_PATH, fontWarmup: !skipFontWarmup });
if (!skipFontWarmup) {
  const plan = planMpvBundleFontCacheWarmup(bundleTarget, { env: mpvEnv, dataDir: mpvDataDir });
  if (plan) {
    const warmStartedAt = Date.now();
    const warm = spawnSync(plan.bin, plan.args, { env: plan.env, encoding: "utf8", timeout: 120_000 });
    log("font cache warm-up (app startup, off the play path)", {
      status: warm.status,
      ms: Date.now() - warmStartedAt,
      stderr: warm.stderr?.slice(-500),
    });
  }
}

const run = (cmd: string, args: string[]) => {
  const res = spawnSync(cmd, args, { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${res.status}): ${res.stderr?.slice(-2000)}`);
  return res.stdout;
};

const buildFixture = () => {
  const master = path.join(FIXTURE_DIR, "master.m3u8");
  if (existsSync(master) && existsSync(path.join(FIXTURE_DIR, "backdrop.jpg"))) {
    log("fixture cached", { dir: FIXTURE_DIR });
    return;
  }
  mkdirSync(FIXTURE_DIR, { recursive: true });
  log("building fixture (system ffmpeg)", { dir: FIXTURE_DIR });
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=0x${BACKDROP_RGB.map((c) => c.toString(16).padStart(2, "0")).join("")}:s=1280x720`,
    "-frames:v", "1", "-q:v", "2", path.join(FIXTURE_DIR, "backdrop.jpg"),
  ]);
  // Same shape as the runtime's VOD output: multi-variant fMP4 HLS, three
  // h264 video variants (1080p ~4 Mbps on top) + two aac renditions in one
  // group, 6 s segments, 4 s GOP at 24 fps, 0-based timestamps.
  run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=24:d=120",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:d=120",
    "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=48000:d=120",
    "-filter_complex", "[0:v]split=3[v1][v2][v3];[v2]scale=854:480[v2o];[v3]scale=640:360[v3o]",
    "-map", "[v1]", "-map", "[v2o]", "-map", "[v3o]", "-map", "1:a", "-map", "2:a",
    "-c:v", "libx264", "-preset", "veryfast", "-g", "96", "-keyint_min", "96", "-sc_threshold", "0",
    "-b:v:0", "4000k", "-b:v:1", "900k", "-b:v:2", "500k",
    "-c:a", "aac", "-b:a", "128k", "-ac", "2",
    "-f", "hls", "-hls_time", "6", "-hls_playlist_type", "vod", "-hls_segment_type", "fmp4",
    "-hls_flags", "independent_segments",
    "-master_pl_name", "master.m3u8",
    "-var_stream_map", "v:0,agroup:aud v:1,agroup:aud v:2,agroup:aud a:0,agroup:aud,default:yes a:1,agroup:aud",
    "-hls_segment_filename", path.join(FIXTURE_DIR, "s%v_%03d.m4s"),
    "-hls_fmp4_init_filename", "init.mp4",
    path.join(FIXTURE_DIR, "p%v.m3u8"),
  ]);
  log("fixture built", { files: run("ls", [FIXTURE_DIR]).split("\n").filter(Boolean).length });
};

const startServer = async (): Promise<{ server: Server; url: string; bytes: () => number }> => {
  const throttle = createPlaybackThrottle(String(kbps));
  let served = 0;
  const server = createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
    const file = path.join(FIXTURE_DIR, rel);
    if (!file.startsWith(FIXTURE_DIR) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    const size = statSync(file).size;
    served += size;
    res.writeHead(200, {
      "content-length": size,
      "content-type": file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp4",
    });
    createReadStream(file).pipe(throttle.wrap(res));
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server_address_missing");
  log("throttled fixture server up", { port: address.port, kbps, active: throttle.isActive() });
  return { server, url: `http://127.0.0.1:${address.port}/master.m3u8`, bytes: () => served };
};

const startXvfb = async (): Promise<{ proc: ChildProcess; display: string }> => {
  const proc = spawn("Xvfb", ["-displayfd", "1", "-screen", "0", "1280x720x24", "-nolisten", "tcp"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const ready = Promise.withResolvers<string>();
  const timer = setTimeout(() => ready.reject(new Error("xvfb_no_display")), 10_000);
  proc.stdout?.once("data", (chunk: Buffer) => {
    clearTimeout(timer);
    ready.resolve(`:${chunk.toString().trim()}`);
  });
  const display = await ready.promise;
  log("Xvfb up", { display, pid: proc.pid });
  return { proc, display };
};

type MpvEvent = { event?: string; request_id?: number; data?: unknown; error?: string; name?: string };

class MpvIpc {
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, (msg: MpvEvent) => void>();
  readonly events: { at: number; event: MpvEvent }[] = [];
  private waiters: { name: string; after: number; resolve: () => void }[] = [];
  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let nl = this.buffer.indexOf("\n");
      while (nl >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        nl = this.buffer.indexOf("\n");
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as MpvEvent;
        if (typeof msg.request_id === "number" && this.pending.has(msg.request_id)) {
          this.pending.get(msg.request_id)?.(msg);
          this.pending.delete(msg.request_id);
        } else if (msg.event) {
          const at = Date.now();
          this.events.push({ at, event: msg });
          if (msg.event !== "property-change") log(`mpv event ${msg.event}`);
          this.waiters = this.waiters.filter((w) => {
            if (w.name === msg.event && at >= w.after) {
              w.resolve();
              return false;
            }
            return true;
          });
        }
      }
    });
    // mpv exiting (e.g. the old bundle on a backdrop it cannot decode) must
    // fail the checks, never hang them on a reply that will not come.
    socket.on("close", () => {
      this.closed = true;
      log("mpv ipc socket closed", { pending: this.pending.size });
      for (const resolve of this.pending.values()) resolve({ error: "ipc_closed" } as MpvEvent);
      this.pending.clear();
    });
  }
  private closed = false;
  static async connect(socketPath: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(socketPath)) {
        const connected = Promise.withResolvers<Socket | null>();
        const s = createConnection(socketPath, () => connected.resolve(s));
        s.once("error", () => connected.resolve(null));
        const socket = await connected.promise;
        if (socket) return new MpvIpc(socket);
      }
      await Bun.sleep(50);
    }
    throw new Error(`ipc_socket_timeout:${socketPath}`);
  }
  command(command: unknown[]): Promise<MpvEvent> {
    if (this.closed) return Promise.resolve({ error: "ipc_closed" } as MpvEvent);
    const request_id = this.nextId++;
    const reply = Promise.withResolvers<MpvEvent>();
    this.pending.set(request_id, reply.resolve);
    this.socket.write(`${JSON.stringify({ command, request_id })}\n`);
    return reply.promise;
  }
  async get(name: string) {
    const reply = await this.command(["get_property", name]);
    return reply.error === "success" ? reply.data : `<${reply.error}>`;
  }
  waitFor(name: string, after: number, timeoutMs: number): Promise<boolean> {
    if (this.events.some((e) => e.event.event === name && e.at >= after)) return Promise.resolve(true);
    const done = Promise.withResolvers<boolean>();
    const timer = setTimeout(() => done.resolve(false), timeoutMs);
    this.waiters.push({ name, after, resolve: () => { clearTimeout(timer); done.resolve(true); } });
    return done.promise;
  }
  close() {
    this.socket.destroy();
  }
}

const dumpState = async (ipc: MpvIpc | null, logFile: string, label: string) => {
  log(`state dump (${label})`);
  if (ipc) {
    for (const prop of ["path", "time-pos", "seeking", "paused-for-cache", "core-idle", "eof-reached", "demuxer-cache-time", "demuxer-cache-state", "video-params", "vo-configured"]) {
      log(`  ${prop}`, await ipc.get(prop));
    }
    log("  last events", ipc.events.slice(-15).map((e) => e.event.event));
  }
  if (existsSync(logFile)) {
    const lines = readFileSync(logFile, "utf8").split("\n");
    log(`  mpv log ${logFile} (${lines.length} lines), last 40:`);
    for (const line of lines.slice(-40)) console.info(`${TAG}   | ${line.slice(0, 300)}`);
  }
};

const centerPixel = (pngPath: string): [number, number, number] => {
  const raw = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", pngPath,
    "-vf", "crop=2:2:(iw-2)/2:(ih-2)/2,scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ]);
  const buf = raw.stdout as Buffer;
  return [buf[0] ?? 0, buf[1] ?? 0, buf[2] ?? 0];
};

const main = async () => {
  mkdirSync(outDir, { recursive: true });
  log("start", { bundleDir, outDir, kbps, host: run("ldd", ["--version"]).split("\n")[0] });

  // 1. Static + start.
  const binEntries = existsSync(mpvLib) ? readdirSync(mpvLib) : [];
  check(binEntries.includes("mpv"), "bundle bin/ present with mpv", { mpvLib, entries: binEntries.length });
  const glibc = binEntries.filter((name) => PRIVATE_GLIBC.some((pattern) => pattern.test(name)));
  check(glibc.length === 0, "bundle carries no private glibc", { glibc });
  const [vCmd, vArgs] = mpvCommand(["--no-config", "--version"]);
  const version = spawnSync(vCmd, vArgs, { env: mpvEnv, encoding: "utf8" });
  const versionText = `${version.stdout ?? ""}${version.stderr ?? ""}`;
  if (!check(version.status === 0, "mpv --version starts on this host", { status: version.status, out: versionText.slice(0, 600) })) {
    return;
  }
  const ffmpegMajor = Number(versionText.match(/FFmpeg version: n?(\d+)/)?.[1] ?? "0");
  check(ffmpegMajor >= 8, "bundle built on FFmpeg >= 8", { ffmpegMajor, line: versionText.match(/FFmpeg version: .*/)?.[0] });

  buildFixture();
  const { server, url, bytes } = await startServer();
  const xvfb = await startXvfb();
  const socketPath = path.join(outDir, "mpv.sock");
  let logFile = path.join(outDir, "mpv.log");
  let mpv: ChildProcess | null = null;
  let ipc: MpvIpc | null = null;
  try {
    // 2. Backdrop: the app's launch args on the local backdrop file.
    process.env.DISPLAY = xvfb.display;
    delete process.env.WAYLAND_DISPLAY;
    const backdrop = path.join(FIXTURE_DIR, "backdrop.jpg");
    const args = buildExternalMpvArgs({
      url: backdrop,
      hwdec: "no",
      logFile,
      extraArgs: [`--input-ipc-server=${socketPath}`, "--image-display-duration=inf", "--ao=null", "--geometry=1280x720+0+0", "-v"],
    });
    const [cmd, cmdArgs] = mpvCommand(args);
    log("launching mpv on backdrop", { cmd, args: cmdArgs, logFile });
    const spawnedAt = Date.now();
    mpv = spawn(cmd, cmdArgs, { env: { ...mpvEnv, DISPLAY: xvfb.display }, stdio: "ignore" });
    mpv.once("exit", (code, signal) => log("mpv exited", { code, signal }));
    ipc = await MpvIpc.connect(socketPath, 10_000);
    // The image may finish loading before the socket connects (its events are
    // gone by then), so poll the decoded frame instead of waiting on an event.
    const backdropDeadline = Date.now() + RESTART_TIMEOUT_MS;
    let videoParams = await ipc.get("video-params");
    while (typeof videoParams !== "object" && Date.now() < backdropDeadline) {
      await Bun.sleep(100);
      videoParams = await ipc.get("video-params");
    }
    const backdropLoaded = typeof videoParams === "object" && videoParams !== null;
    log("backdrop first frame (cold launch)", {
      firstFrameMs: backdropLoaded ? Date.now() - spawnedAt : null,
      fontCacheWarmedAtStartup: !skipFontWarmup,
    });
    check(backdropLoaded, "backdrop image decoded (video-params set)", { path: await ipc.get("path"), videoParams });
    await Bun.sleep(1000);
    const shot = path.join(outDir, "backdrop-screen.png");
    // -draw_mouse 0: Xvfb parks its black X cursor exactly on the screen
    // centre, which is the pixel we sample.
    run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "x11grab", "-draw_mouse", "0", "-video_size", "1280x720", "-i", xvfb.display, "-frames:v", "1", shot]);
    const pixel = centerPixel(shot);
    const distance = Math.max(...pixel.map((c, i) => Math.abs(c - BACKDROP_RGB[i])));
    check(distance <= 24, "backdrop renders in the mpv window (screen centre = backdrop colour)", { pixel, expected: BACKDROP_RGB, distance, shot });
    if (!backdropLoaded) await dumpState(ipc, logFile, "backdrop");
    if (mpv.exitCode !== null || mpv.signalCode !== null) {
      // The backdrop killed mpv (old bundle: no image decoders). Relaunch it
      // idle, as the app did pre-fix, so the start/seek checks below still
      // exercise the stream path instead of failing on a dead process.
      ipc.close();
      rmSync(socketPath, { force: true });
      const idleArgs = buildExternalMpvArgs({
        url: null,
        hwdec: "no",
        logFile: `${logFile}.idle.log`,
        extraArgs: [`--input-ipc-server=${socketPath}`, "--ao=null", "--geometry=1280x720+0+0", "-v"],
      });
      const [idleCmd, idleCmdArgs] = mpvCommand(idleArgs);
      log("mpv died on the backdrop; relaunching idle for the stream checks", { cmd: idleCmd, args: idleCmdArgs });
      mpv = spawn(idleCmd, idleCmdArgs, { env: { ...mpvEnv, DISPLAY: xvfb.display }, stdio: "ignore" });
      mpv.once("exit", (code, signal) => log("mpv (idle relaunch) exited", { code, signal }));
      ipc = await MpvIpc.connect(socketPath, 10_000);
      logFile = `${logFile}.idle.log`;
    }

    // 3. Handoff to HLS with a mid-segment start over the throttled link.
    const loadAt = Date.now();
    const load = buildLoadfileCommand(url, "replace", { startSeconds: START_SECONDS, paused: false });
    log("handoff loadfile", load);
    await ipc.command(load.command);
    const started = await ipc.waitFor("playback-restart", loadAt + 1, RESTART_TIMEOUT_MS);
    const startPos = Number(await ipc.get("time-pos"));
    check(started && startPos >= START_SECONDS - 0.5, `mid-segment start=${START_SECONDS} restarts within ${RESTART_TIMEOUT_MS} ms on a ${kbps} kbps link`, {
      started, ms: Date.now() - loadAt, timePos: startPos, servedBytes: bytes(),
    });
    if (!started) await dumpState(ipc, logFile, "start");
    await Bun.sleep(2000);

    // 4. Mid-segment seek.
    const seekAt = Date.now();
    log("seek", { to: SEEK_SECONDS });
    await ipc.command(["seek", SEEK_SECONDS, "absolute"]);
    const seeked = await ipc.waitFor("playback-restart", seekAt + 1, RESTART_TIMEOUT_MS);
    const seekPos = Number(await ipc.get("time-pos"));
    check(seeked && Math.abs(seekPos - SEEK_SECONDS) < 2, `mid-segment seek to ${SEEK_SECONDS} restarts within ${RESTART_TIMEOUT_MS} ms`, {
      seeked, ms: Date.now() - seekAt, timePos: seekPos, servedBytes: bytes(),
    });
    if (!seeked) await dumpState(ipc, logFile, "seek");
    await Bun.sleep(1500);
    const advanced = Number(await ipc.get("time-pos"));
    check(advanced > seekPos, "playback advances after the seek", { before: seekPos, after: advanced });
    const nalErrors = readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes("Invalid NAL unit size")).length;
    log("mpv log 'Invalid NAL unit size' lines", { nalErrors });
  } finally {
    ipc?.close();
    mpv?.kill("SIGTERM");
    xvfb.proc.kill("SIGTERM");
    server.close();
  }
};

// Hard cap: a smoke that hangs holds the shared heavy lock for everyone.
const SMOKE_WATCHDOG_MS = 180_000;
setTimeout(() => {
  log(`FAILED watchdog: smoke still running after ${SMOKE_WATCHDOG_MS} ms`, failures);
  process.exit(1);
}, SMOKE_WATCHDOG_MS).unref();
await main().catch((error) => {
  failures.push(`crash: ${error instanceof Error ? error.stack : String(error)}`);
});
log(failures.length === 0 ? "ALL PASS" : `FAILED (${failures.length})`, failures);
log("evidence", { outDir });
process.exit(failures.length === 0 ? 0 : 1);
