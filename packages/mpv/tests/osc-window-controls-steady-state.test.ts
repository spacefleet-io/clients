/**
 * @bugfix osc-window-controls-section-repushed-every-frame
 * @regression-proof
 *
 * Size/perf audit §4.3 (#25): with the OSC visible, tog4in1 ran
 * `mp.enable_key_bindings("window-controls")` on EVERY render tick, i.e. once
 * per video frame. Each call is an mpv `enable-section` command, and the
 * always-debug mpv log file writes one line per command:
 *
 *   [d][cplayer] Run command: enable-section, flags=64, args=[name="window-controls", flags=""]
 *
 * ≈24 lines/s at 24 fps, about 2.7 KB/s, 30 % of a real 30 s ultimate-run log
 * (`c026-trend/fix1/shard-1/logs/mpv-1-*.log`: 834 lines, 79,470 B), plus the
 * input-stack rebuild each command costs the core thread.
 *
 * The per-tick re-push existed to keep window-controls above sf.lua's forced
 * MBTN_LEFT section. tog4in1 now pushes it only when OSC visibility flips, and
 * once more when sf.lua reports its key bindings are live (`sf-bindings-ready`),
 * so a late sf.lua flush cannot land above it.
 *
 * Drives the REAL mpv with the REAL tog4in1.lua + sf.lua (fullscreen 1920x1080,
 * own Xvfb, 24 fps file, OSC held visible):
 *   - no `window-controls` section command while the OSC stays visible;
 *   - window-controls' MBTN_LEFT outranks sf.lua's (a click in the top band is
 *     the OSC's, not sf.lua's click-to-pause), also after sf.lua's handshake.
 * Pre-fix the first assertion sees ≈24 commands per second.
 *
 * Skips (loudly) without a runnable mpv or without xvfb-run.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireMediaBinary } from "@space/media-deps";
import { resolveExternalMpvTarget } from "../src/external";
import { resolveMpvOscScript } from "../src/index";

const TAG = "[osc-window-controls-steady-state]";
const STEADY_MS = 3_000;
const WC_SECTION_LINE = /(enable|disable)-section.*name="window-controls"/;
const SF_SECTION_LINE = /enable-section.*name="input_forced_sf"/;
const SF_READY_LINE = /Run command: script-message,.*"sf-bindings-ready"/;
const WC_ENABLE_LINE = /enable-section.*name="window-controls"/;

const target = process.platform === "linux" ? resolveExternalMpvTarget() : null;
const oscScript = resolveMpvOscScript();
const oscDir = oscScript ? join(oscScript, "..") : null;
const xvfbRun = spawnSync("sh", ["-c", "command -v xvfb-run"]).status === 0;
const ffmpeg = spawnSync("sh", ["-c", "command -v ffmpeg"]).status === 0;
requireMediaBinary("mpv (shipped bundle) + sf.lua", Boolean(target && target.kind !== "fallback" && oscScript));
requireMediaBinary("xvfb-run", xvfbRun);
requireMediaBinary("ffmpeg", ffmpeg);
const runnable = Boolean(target && target.kind !== "fallback" && oscScript && xvfbRun && ffmpeg);
if (!runnable) {
  console.warn(
    `${TAG} SKIP: platform=${process.platform} mpv=${target?.kind ?? "n/a"} osc=${oscScript ?? "none"} xvfb-run=${xvfbRun} ffmpeg=${ffmpeg}. Run \`bun run setup:binaries\` and install xvfb + ffmpeg.`,
  );
}

// Real-clock waits are deliberate: this drives a separate mpv process (render
// ticks per video frame) whose clock fake timers cannot control. Every wait is
// a bounded poll on an observable condition except the steady-state window,
// which IS the measurement.
const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

type Harness = { dir: string; mpv: ChildProcess; logFile: string; sock: string };
type Binding = { section?: string; key?: string; priority?: number };
type Reply = { request_id?: number; data?: unknown; error?: string };
const live: Harness[] = [];
const conns: Socket[] = [];

const connect = async (sock: string) => {
  const client = createConnection(sock);
  conns.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  let buf = "";
  let nextId = 1;
  const waiting = new Map<number, (r: Reply) => void>();
  client.on("data", (chunk) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Reply;
      if (typeof msg.request_id === "number") waiting.get(msg.request_id)?.(msg);
    }
  });
  return async (command: unknown[]): Promise<Reply> => {
    const id = nextId++;
    const { promise, resolve } = Promise.withResolvers<Reply>();
    const timer = setTimeout(() => resolve({ request_id: id, error: `timeout ${JSON.stringify(command)}` }), 5_000);
    waiting.set(id, (r) => {
      clearTimeout(timer);
      waiting.delete(id);
      resolve(r);
    });
    client.write(`${JSON.stringify({ command, request_id: id })}\n`);
    return promise;
  };
};

const dumpLog = (h: Harness, filter?: RegExp): string => {
  try {
    const lines = readFileSync(h.logFile, "utf8").split("\n");
    const picked = filter ? lines.filter((l) => filter.test(l)) : lines;
    return `--- mpv log (${h.logFile}) ---\n${picked.slice(-80).join("\n")}`;
  } catch (err) {
    return `(no mpv log: ${err instanceof Error ? err.message : String(err)})`;
  }
};

const SECTION_LINES = /enable-section|disable-section|sf-bindings-ready|Set property: pause/;

const launch = async (extra: string[], { tog4in1 = true }: { tog4in1?: boolean } = {}): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), "sf-osc-wc-"));
  const sock = join(dir, "mpv.sock");
  const logFile = join(dir, "mpv.log");
  // 24 fps like real content: tog4in1 renders once per displayed frame.
  const fixture = join(dir, "fixture.mkv");
  const enc = spawnSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=64x36:r=24:d=120",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", fixture,
  ]);
  if (enc.status !== 0) throw new Error(`${TAG} fixture encode failed: ${enc.stderr?.toString()}`);
  // Same input/script wiring as apps/badger external mpv launch.
  const args = [
    "--no-config",
    "--force-window=yes",
    "--keep-open=yes",
    "--vo=x11",
    "--ao=null",
    "--hwdec=no",
    "--no-terminal",
    "--osc=no",
    "--load-scripts=no",
    "--border=no",
    "--input-default-bindings=no",
    `--input-conf=${join(oscDir!, "input.conf")}`,
    `--osd-fonts-dir=${join(oscDir!, "tog4in1", "fonts")}`,
    ...(tog4in1 ? [`--script=${join(oscDir!, "tog4in1", "tog4in1.lua")}`] : []),
    `--script=${oscScript}`,
    "--fullscreen",
    "--geometry=1920x1080+0+0",
    `--log-file=${logFile}`,
    `--input-ipc-server=${sock}`,
    ...extra,
    fixture,
  ];
  const env = {
    ...process.env,
    ...(target!.kind === "bundle" && target!.libDirs.length > 0
      ? { LD_LIBRARY_PATH: [target!.libDirs.join(":"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
      : {}),
  };
  const wrapper = ["xvfb-run", "-a", "-s", "-screen 0 1920x1080x24"];
  console.info(`${TAG} launch bin=${target!.bin} kind=${target!.kind} osc=${oscDir} tog4in1=${tog4in1} extra=${extra.join(" ")}`);
  console.info(`${TAG} mpv log file: ${logFile}`);
  const mpv = spawn(wrapper[0]!, [...wrapper.slice(1), target!.bin, ...args], { stdio: "ignore", detached: true, env });
  mpv.unref();
  const h: Harness = { dir, mpv, logFile, sock };
  live.push(h);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !existsSync(sock)) {
    if (mpv.exitCode !== null) throw new Error(`${TAG} mpv exited early code=${mpv.exitCode}\n${dumpLog(h)}`);
    await sleep(50);
  }
  if (!existsSync(sock)) throw new Error(`${TAG} mpv IPC socket never appeared\n${dumpLog(h)}`);
  console.info(`${TAG} mpv ready pid=${mpv.pid}`);
  return h;
};

const mbtnLeft = (bindings: unknown, section: string): number => {
  if (!Array.isArray(bindings)) return -1;
  const b = (bindings as Binding[]).find((x) => x.section === section && x.key?.toUpperCase() === "MBTN_LEFT");
  return b?.priority ?? -1;
};

/** Poll until tog4in1's window-controls MBTN_LEFT is live (OSC visible) and sf.lua's binding exists. */
const waitWindowControlsLive = async (h: Harness, ipc: (c: unknown[]) => Promise<Reply>) => {
  const deadline = Date.now() + 15_000;
  let wc = -1;
  let sf = -1;
  while (Date.now() < deadline) {
    const bindings = (await ipc(["get_property", "input-bindings"])).data;
    wc = mbtnLeft(bindings, "window-controls");
    sf = mbtnLeft(bindings, "input_forced_sf");
    if (wc >= 0 && sf >= 0) break;
    await sleep(50);
  }
  console.info(`${TAG} MBTN_LEFT priority window-controls=${wc} input_forced_sf=${sf}`);
  if (wc < 0 || sf < 0) console.error(`${TAG} FAIL dump\n${dumpLog(h, SECTION_LINES)}`);
  expect(wc, "window-controls MBTN_LEFT never became live (OSC not visible?)").toBeGreaterThanOrEqual(0);
  expect(sf, "sf.lua MBTN_LEFT binding never appeared").toBeGreaterThanOrEqual(0);
  return { wc, sf };
};

/** Poll the mpv log until a line matching `re` appears at index >= `from`. */
const waitLine = async (h: Harness, re: RegExp, from: number, ms: number): Promise<{ lines: string[]; at: number }> => {
  const deadline = Date.now() + ms;
  let lines: string[] = [];
  while (Date.now() < deadline) {
    lines = readFileSync(h.logFile, "utf8").split("\n");
    const at = lines.findIndex((l, i) => i >= from && re.test(l));
    if (at >= 0) return { lines, at };
    await sleep(50);
  }
  return { lines, at: -1 };
};

/**
 * The input bindings once the section commands have stopped: no enable/disable-section line for 400 ms (at most 5 s).
 * A re-layout right after load can briefly disable and re-enable tog4in1's sections (run 47564: disable at 0.237 s,
 * enable at 0.255 s); a snapshot inside that gap reads window-controls as absent although the settled stack has it.
 */
const settledBindings = async (h: Harness, ipc: (c: unknown[]) => Promise<Reply>): Promise<unknown> => {
  const deadline = Date.now() + 5_000;
  const count = () => readFileSync(h.logFile, "utf8").split("\n").filter((l) => /(enable|disable)-section/.test(l)).length;
  let seen = count();
  let quietSince = Date.now();
  while (Date.now() < deadline && Date.now() - quietSince < 400) {
    await sleep(50);
    const now = count();
    if (now !== seen) {
      seen = now;
      quietSince = Date.now();
    }
  }
  console.info(`${TAG} section commands settled=${Date.now() - quietSince >= 400} after ${seen} lines`);
  return (await ipc(["get_property", "input-bindings"])).data;
};

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

describe.skipIf(!runnable)("tog4in1 window-controls section while the OSC stays visible (real mpv, fullscreen)", () => {
  it("issues no window-controls section command per frame while playing with the OSC held visible", async () => {
    const h = await launch(["--script-opts=osc-visibility=always"]);
    const ipc = await connect(h.sock);
    await waitWindowControlsLive(h, ipc);
    // Let startup settle (first layout, sf.lua handshake) before measuring.
    await sleep(500);
    const before = readFileSync(h.logFile, "utf8");
    const framesBefore = (await ipc(["get_property", "estimated-frame-number"])).data;
    await sleep(STEADY_MS);
    const framesAfter = (await ipc(["get_property", "estimated-frame-number"])).data;
    const after = readFileSync(h.logFile, "utf8");
    const window = after.slice(before.length).split("\n");
    const wcLines = window.filter((l) => WC_SECTION_LINE.test(l));
    const bytesPerSec = Math.round(((statSync(h.logFile).size - Buffer.byteLength(before)) * 1000) / STEADY_MS);
    console.info(
      `${TAG} steady ${STEADY_MS} ms: frames ${String(framesBefore)} -> ${String(framesAfter)}, window-controls section commands=${wcLines.length}, log ≈${bytesPerSec} B/s, lines=${window.length}`,
    );
    console.info(`${TAG} first window-controls lines in the window:\n${wcLines.slice(0, 5).join("\n")}`);
    expect(typeof framesAfter === "number" && typeof framesBefore === "number" && framesAfter > framesBefore, "video must be playing").toBe(true);
    if (wcLines.length > 0) console.error(`${TAG} FAIL dump\n${dumpLog(h, SECTION_LINES)}`);
    expect(wcLines.length, "window-controls must not be re-pushed while OSC visibility is unchanged").toBe(0);
  }, 90_000);

  it("keeps window-controls above sf.lua's MBTN_LEFT, including after sf.lua reports its bindings live", async () => {
    // Start paused: showonpause reveals the OSC on its first ticks, i.e. while
    // sf.lua may still be flushing its own forced section (the resume-paused launch).
    const h = await launch(["--pause"]);
    const ipc = await connect(h.sock);
    const { wc, sf } = await waitWindowControlsLive(h, ipc);
    const readyHit = await waitLine(h, SF_READY_LINE, 0, 5_000);
    const lastSfEnable = readyHit.lines.findLastIndex((l) => SF_SECTION_LINE.test(l));
    const ready = readyHit.lines.findIndex((l, i) => i > lastSfEnable && SF_READY_LINE.test(l));
    // The re-push lands a few ms after the ready line: wait for it, never judge
    // the snapshot that first showed the ready line.
    const wcAfterReady = ready < 0 ? -1 : (await waitLine(h, WC_ENABLE_LINE, ready + 1, 5_000)).at;
    console.info(`${TAG} log order: last sf section enable=${lastSfEnable} sf-bindings-ready=${ready} window-controls enable after it=${wcAfterReady}`);
    const final = await settledBindings(h, ipc);
    const wcFinal = mbtnLeft(final, "window-controls");
    const sfFinal = mbtnLeft(final, "input_forced_sf");
    console.info(`${TAG} MBTN_LEFT priority first-live wc=${wc} sf=${sf}; final wc=${wcFinal} sf=${sfFinal}`);
    if (ready < 0 || wcAfterReady < 0 || !(wcFinal > sfFinal)) console.error(`${TAG} FAIL dump\n${dumpLog(h, SECTION_LINES)}`);
    expect(lastSfEnable, "sf.lua's forced section enable must be in the log").toBeGreaterThanOrEqual(0);
    expect(ready, "sf.lua must tell tog4in1 once its forced bindings are live").toBeGreaterThan(lastSfEnable);
    expect(wcAfterReady, "tog4in1 must re-push window-controls after sf.lua's handshake while visible").toBeGreaterThan(ready);
    expect(wcFinal, "window-controls MBTN_LEFT must outrank sf.lua's").toBeGreaterThan(sfFinal);
  }, 90_000);

  it("re-pushes window-controls when tog4in1 loads after sf.lua already announced its bindings live", async () => {
    // The other load order: sf.lua's one-shot sf-bindings-ready broadcast is
    // over before tog4in1 listens, so only tog4in1's sf-bindings-query (answered
    // by sf.lua while live) can tell it to re-stack window-controls (#25 CI: no
    // re-push seen when tog4in1 registered late).
    const h = await launch(["--pause"], { tog4in1: false });
    const ipc = await connect(h.sock);
    const firstReady = await waitLine(h, SF_READY_LINE, 0, 15_000);
    console.info(`${TAG} sf-bindings-ready broadcast at log line ${firstReady.at} before tog4in1 is loaded`);
    expect(firstReady.at, "sf.lua must announce its bindings before tog4in1 loads").toBeGreaterThanOrEqual(0);
    const loadAt = firstReady.lines.length;
    const loaded = await ipc(["load-script", join(oscDir!, "tog4in1", "tog4in1.lua")]);
    console.info(`${TAG} load-script tog4in1 -> ${JSON.stringify(loaded)}`);
    const { wc, sf } = await waitWindowControlsLive(h, ipc);
    const reply = await waitLine(h, SF_READY_LINE, loadAt, 5_000);
    // The re-push lands a few ms after the reply line: wait for it too.
    const wcAfterReply = reply.at < 0 ? -1 : (await waitLine(h, WC_ENABLE_LINE, reply.at + 1, 5_000)).at;
    const final = await settledBindings(h, ipc);
    const wcFinal = mbtnLeft(final, "window-controls");
    const sfFinal = mbtnLeft(final, "input_forced_sf");
    console.info(
      `${TAG} late load: sf-bindings-ready reply at ${reply.at} (load at ${loadAt}), window-controls enable after it=${wcAfterReply}; MBTN_LEFT first-live wc=${wc} sf=${sf}, final wc=${wcFinal} sf=${sfFinal}`,
    );
    if (reply.at < 0 || wcAfterReply < 0 || !(wcFinal > sfFinal)) console.error(`${TAG} FAIL dump\n${dumpLog(h, SECTION_LINES)}`);
    expect(reply.at, "sf.lua must answer a late tog4in1's sf-bindings-query").toBeGreaterThanOrEqual(loadAt);
    expect(wcAfterReply, "tog4in1 must re-push window-controls after the reply").toBeGreaterThan(reply.at);
    expect(wcFinal, "window-controls MBTN_LEFT must outrank sf.lua's").toBeGreaterThan(sfFinal);
  }, 90_000);
});
