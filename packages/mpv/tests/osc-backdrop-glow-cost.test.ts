/**
 * @bugfix osc-backdrop-glow-redraw-cost
 * @regression-proof
 *
 * Replay R2 (47e9ad88) c017 / c022 `video_skipped_frames` + `mpv_drop_rate` (#25):
 * residual mpv drops (27 / 30) clustered in the spans where the OSC is up, after
 * the harness-induced part was removed (PR #215).
 *
 * Cause (measured live, --vo=x11 --hwdec=no, 4 cpus CPUQuota=200%/10ms, 1920x1080
 * fullscreen, transcode load, OSC held revealed): the first ASS element of
 * tog4in1, `transBg`, is a 10-virtual-px box styled `\blur75\bord100`. At the
 * fullscreen scale (2.8) that is a ~700 px tall blurred glow spanning the full
 * width, rasterized and blended by the software OSD on every OSD update. vo
 * thread CPU by backdrop glow reach (bord + 2*blur) * 2.8 px:
 *
 *   bare reference (no OSC)        0 px    ~10 %
 *   no backdrop                    0 px    ~12 %
 *   \blur12 \bord40              179 px    ~19 %
 *   \blur20 \bord30              196 px    ~21 %
 *   \blur20 \bord45              238 px    ~24 %
 *   \blur30 \bord60              336 px    ~28 %
 *   \blur40 \bord70              420 px    ~36 %
 *   \blur75 \bord100 (pre-fix)   700 px    ~45 %   (+ 7..79 mpv drops per 24 s)
 *
 * The cost grows with the glow's pixel area, so this test bounds the area
 * deterministically instead of timing frames: the OSC's `sf-e2e-layout` hook
 * reports every laid-out element's `\blur` / `\bord` and the OSD geometry from
 * the REAL mpv + REAL tog4in1.lua (fullscreen 1920x1080 under its own Xvfb).
 * No element may paint a glow that reaches further than MAX_GLOW_FRACTION of the
 * OSD height. Pre-fix `transBg` reaches 700 / 1080 = 65 %.
 *
 * Skips (loudly) without a runnable mpv or without xvfb-run.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REAL_MEDIA_TESTS_ENV, realMediaTestsRequested, requireMediaBinary } from "@space/media-deps";
import { resolveExternalMpvTarget } from "../src/external";
import { resolveMpvOscScript } from "../src/index";

const TAG = "[osc-backdrop-glow-cost]";
/** Glow reach (bord + 2*blur, OSD px) must stay below this share of the OSD height. */
const MAX_GLOW_FRACTION = 0.25;
const READY_MARKER = "SF_OSC_GLOW_PLAYING";

const target = process.platform === "linux" ? resolveExternalMpvTarget() : null;
const oscScript = resolveMpvOscScript();
const oscDir = oscScript ? join(oscScript, "..") : null;
const xvfbRun = spawnSync("sh", ["-c", "command -v xvfb-run"]).status === 0;
const ffmpeg = spawnSync("sh", ["-c", "command -v ffmpeg"]).status === 0;
// Real-mpv layout reads: only in the dedicated media-real-test job (SF_REAL_MEDIA_TESTS=1, ci.yaml), never in a unit
// job on a loaded shared runner, where mpv stalls for seconds.
const realMedia = realMediaTestsRequested();
if (realMedia) {
  requireMediaBinary("mpv (shipped bundle) + sf.lua", Boolean(target && target.kind !== "fallback" && oscScript));
  requireMediaBinary("xvfb-run", xvfbRun);
  requireMediaBinary("ffmpeg", ffmpeg);
}
const runnable = realMedia && Boolean(target && target.kind !== "fallback" && oscScript && xvfbRun && ffmpeg);
if (!runnable) {
  console.warn(
    `${TAG} SKIP: ${REAL_MEDIA_TESTS_ENV}=${realMedia ? "1" : "unset"} platform=${process.platform} mpv=${target?.kind ?? "n/a"} osc=${oscScript ?? "none"} xvfb-run=${xvfbRun} ffmpeg=${ffmpeg}. Run \`bun run setup:binaries\`, install xvfb + ffmpeg and set ${REAL_MEDIA_TESTS_ENV}=1.`,
  );
}

type Harness = { dir: string; mpv: ChildProcess; logFile: string; sock: string; stdout: () => string };
type IpcMessage = { event?: string; name?: string; data?: unknown; args?: string[]; request_id?: number; error?: string };
const live: Harness[] = [];
const conns: Socket[] = [];

const dumpLog = (h: Harness, filter?: RegExp): string => {
  try {
    const lines = readFileSync(h.logFile, "utf8").split("\n");
    const picked = filter ? lines.filter((l) => filter.test(l)) : lines;
    return `--- mpv log (${h.logFile}) ---\n${picked.slice(-80).join("\n")}`;
  } catch (err) {
    return `(no mpv log: ${err instanceof Error ? err.message : String(err)})`;
  }
};

// No wall-clock waits anywhere: readiness is the stdout marker mpv prints when
// playback starts (scripts already loaded), the IPC socket is then connectable,
// and every later step awaits an IPC event (property change / client-message).
// A hang is bounded by the vitest test timeout.
const launch = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "sf-osc-glow-"));
  const sock = join(dir, "mpv.sock");
  const logFile = join(dir, "mpv.log");
  const fixture = join(dir, "fixture.mkv");
  const enc = spawnSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=64x36:r=4:d=600",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "8", fixture,
  ]);
  if (enc.status !== 0) throw new Error(`${TAG} fixture encode failed: ${enc.stderr?.toString()}`);
  const args = [
    "--no-config",
    "--idle=yes",
    "--force-window=yes",
    "--keep-open=yes",
    "--vo=x11",
    "--ao=null",
    "--hwdec=no",
    "--osc=no",
    "--load-scripts=no",
    "--border=no",
    "--input-default-bindings=no",
    `--input-conf=${join(oscDir!, "input.conf")}`,
    `--osd-fonts-dir=${join(oscDir!, "tog4in1", "fonts")}`,
    `--script=${join(oscDir!, "tog4in1", "tog4in1.lua")}`,
    "--fullscreen",
    "--geometry=1920x1080+0+0",
    `--term-playing-msg=${READY_MARKER}`,
    "--msg-level=all=v",
    `--log-file=${logFile}`,
    `--input-ipc-server=${sock}`,
    fixture,
  ];
  const env = {
    ...process.env,
    ...(target!.kind === "bundle" && target!.libDirs.length > 0
      ? { LD_LIBRARY_PATH: [target!.libDirs.join(":"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
      : {}),
  };
  console.info(`${TAG} launch bin=${target!.bin} kind=${target!.kind} osc=${oscDir}`);
  console.info(`${TAG} mpv log file: ${logFile}`);
  const mpv = spawn("xvfb-run", ["-a", "-s", "-screen 0 1920x1080x24", target!.bin, ...args], {
    stdio: ["ignore", "pipe", "ignore"],
    detached: true,
    env,
  });
  mpv.unref();
  let out = "";
  mpv.stdout!.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  const h: Harness = { dir, mpv, logFile, sock, stdout: () => out };
  live.push(h);
  return h;
};

/** Resolves once mpv prints the playing marker on its own stdout line; rejects if mpv exits first. */
const untilPlaying = (h: Harness): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  // Whole-line match: the verbose "Command line options" dump also contains the marker.
  const check = () => {
    if (h.stdout().split("\n").some((l) => l.trim() === READY_MARKER)) resolve();
  };
  h.mpv.stdout!.on("data", check);
  h.mpv.once("exit", (code) => reject(new Error(`${TAG} mpv exited early code=${code}\n${dumpLog(h)}`)));
  check();
  return promise;
};

/** One persistent IPC connection that fans every mpv event out to waiters. */
const connect = async (sock: string) => {
  const client = createConnection(sock);
  conns.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  let buf = "";
  const waiters = new Set<(m: IpcMessage) => void>();
  client.on("data", (chunk) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as IpcMessage;
      for (const w of [...waiters]) w(msg);
    }
  });
  const send = (command: unknown[]) => client.write(`${JSON.stringify({ command })}\n`);
  const until = <T>(pick: (m: IpcMessage) => T | undefined): Promise<T> => {
    const { promise, resolve } = Promise.withResolvers<T>();
    const waiter = (m: IpcMessage) => {
      const v = pick(m);
      if (v !== undefined) {
        waiters.delete(waiter);
        resolve(v);
      }
    };
    waiters.add(waiter);
    return promise;
  };
  return { send, until };
};

type LayoutElement = { x1: number; y1: number; x2: number; y2: number; blur?: number; bord?: number };
type Layout = { osd_w: number; osd_h: number; virt_per_osd_y: number; elements: Record<string, LayoutElement> };

afterEach(() => {
  for (const c of conns.splice(0)) c.destroy();
  for (const h of live.splice(0)) {
    const reaped = spawnSync("pkill", ["-KILL", "-f", h.logFile]);
    console.info(`${TAG} cleanup pkill -f ${h.logFile} status=${reaped.status}`);
    if (h.mpv.pid) {
      try {
        process.kill(-h.mpv.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    rmSync(h.dir, { recursive: true, force: true });
  }
});

describe.skipIf(!runnable)("tog4in1 backdrop glow reach (real mpv, fullscreen)", () => {
  it("no element paints a blurred glow reaching further than a quarter of the OSD height", async () => {
    const h = launch();
    await untilPlaying(h);
    console.info(`${TAG} mpv playing, connecting IPC`);
    const ipc = await connect(h.sock);
    // Fullscreen is async under Xvfb: wait for the OSD to reach 1080 px before
    // asking for the layout (the OSC lays out on the osd-dimensions change).
    ipc.send(["observe_property", 1, "osd-height"]);
    ipc.send(["observe_property", 2, "duration"]);
    const ready = Promise.all([
      ipc.until((m) => (m.event === "property-change" && m.name === "osd-height" && m.data === 1080 ? true : undefined)),
      ipc.until((m) => (m.event === "property-change" && m.name === "duration" && typeof m.data === "number" ? true : undefined)),
    ]);
    await ready;
    console.info(`${TAG} osd-height=1080 and duration known; requesting layout`);
    // The reply is a script-message delivered to IPC clients as a client-message event.
    const reply = ipc.until((m) =>
      m.event === "client-message" && m.args?.[0] === "sf-e2e-layout-json" ? (JSON.parse(m.args[1]!) as Layout) : undefined,
    );
    ipc.send(["script-message", "sf-e2e-layout"]);
    const layout = await reply;
    const reach = Object.entries(layout.elements).map(([name, el]) => {
      const reachPx = ((el.bord ?? 0) + 2 * (el.blur ?? 0)) / layout.virt_per_osd_y;
      return { name, blur: el.blur ?? 0, bord: el.bord ?? 0, reachPx, fraction: reachPx / layout.osd_h };
    });
    reach.sort((a, b) => b.reachPx - a.reachPx);
    console.info(`${TAG} osd=${layout.osd_w}x${layout.osd_h} virt_per_osd_y=${layout.virt_per_osd_y} budget=${MAX_GLOW_FRACTION}`);
    console.info(`${TAG} glow reach top 8: ${JSON.stringify(reach.slice(0, 8))}`);
    const transBg = layout.elements.transBg;
    console.info(`${TAG} transBg=${JSON.stringify(transBg)}`);
    expect(transBg, "transBg backdrop element must still be laid out").toBeDefined();
    expect(transBg!.blur ?? 0, "backdrop keeps a blur (soft gradient look)").toBeGreaterThan(0);
    const worst = reach[0]!;
    if (worst.fraction > MAX_GLOW_FRACTION) console.error(`${TAG} FAIL dump\n${dumpLog(h, /sf-e2e-layout/)}`);
    expect(
      worst.fraction,
      `${worst.name} glow reaches ${worst.reachPx.toFixed(0)} px of ${layout.osd_h} px (blur ${worst.blur}, bord ${worst.bord})`,
    ).toBeLessThanOrEqual(MAX_GLOW_FRACTION);
  }, 90_000);
});
