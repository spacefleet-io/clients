/**
 * @bugfix osc-click-lost-on-pause-toggle
 * @regression-proof
 *
 * Replay R2 (47e9ad88) c013 `track-menu-not-opened` (#25). The track-menu click
 * never reached the OSC:
 *
 *   shard-1/logs/mpv-7-*.log  (t = seconds since mpv start)
 *   [5.343] Set property: pause=true -> 1     (product, ipc_101)
 *   [5.347] disable-section "input" + "window-controls", enable-section ...  (tick re-enabled in the same ms)
 *   [5.556] Set property: pause=false -> 1    (product, ipc_107)
 *   [5.556] mouse 518 996                     (harness: cy_audio centre)
 *   [5.561] disable-section "input" + "window-controls"   <-- OSC input section off
 *   [5.561] keydown MBTN_LEFT -> script-binding sf/sf-pill-click   (NOT tog4in1)
 *   [5.597] enable-section "input" ...        <-- 36 ms later (loaded host)
 *   [5.672] keyup MBTN_LEFT -> sf/sf-pill-click
 *
 * tog4in1 `pause_state()` (showonpause) calls `visibility_mode()`, which
 * disabled the "input" and "window-controls" sections EAGERLY and left the
 * re-enable to the next render tick. Any MBTN_LEFT in that window goes to the
 * player's own bindings; the OSC button never fires. A real user hits the
 * same window when clicking right after a pause/resume.
 *
 * This test drives the REAL mpv with the REAL tog4in1.lua + sf.lua under its own
 * Xvfb. With the OSC revealed, it toggles `pause` and, in the same IPC write,
 * pipelines a burst of `get_property input-bindings`. The burst is answered by
 * mpv's core thread back to back, i.e. it samples the input stack while the OSC
 * script is still reacting to the toggle. The OSC's MBTN_LEFT binding (section
 * "input") must stay enabled (priority >= 0) in every sample. Pre-fix the
 * eager disable shows up as samples with priority -1 within milliseconds.
 *
 * A resume legitimately hides the OSC: showonpause restores "auto", which
 * fades it out over `fadedurationMouseMove` (500 ms) and THEN disables its
 * sections (measured on the media-deps bundle: disable lands 520-590 ms after
 * pause=false). A burst slower than that (loaded CI, slower bundle) sampled
 * that designed hide and failed staging intermittently. Only samples whose
 * reply arrived within JUDGE_WINDOW_MS of the write are judged: a reply
 * arrives after mpv took the sample, so a judged sample was taken well before
 * the fade could end, and the eager disable still lands inside the window.
 *
 * Skips (loudly) without a runnable mpv or without xvfb-run.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireMediaBinary } from "@space/media-deps";
import { resolveExternalMpvTarget } from "../src/external";
import { resolveMpvOscScript } from "../src/index";

const TAG = "[osc-input-survives-pause-toggle]";
const OSC_INPUT_SECTION = "input";
const TOGGLES = 12;
const BURST = 400;
/** Below tog4in1's 500 ms resume fade-out (fadedurationMouseMove), with margin. */
const JUDGE_WINDOW_MS = 300;
/** A toggle with fewer judged samples than this proves nothing: fail instead of passing vacuously. */
const MIN_JUDGED_PER_TOGGLE = 20;

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

// Real-clock waits are deliberate: this drives a separate mpv process (input
// stack, OSC render ticks) whose clock fake timers cannot control. Every wait
// is a bounded poll on an observable condition.
const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

type Harness = { dir: string; mpv: ChildProcess; logFile: string; sock: string };
type Binding = { section?: string; key?: string; priority?: number };
/** receivedAt: performance.now() at arrival; elapsedMs: arrival minus the batch's write. */
type Reply = { request_id?: number; data?: unknown; error?: string; receivedAt?: number; elapsedMs?: number };
const live: Harness[] = [];
const conns: Socket[] = [];

/** One persistent IPC connection; `send` writes a batch in ONE socket write and resolves every reply by id. */
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
      if (typeof msg.request_id === "number") waiting.get(msg.request_id)?.({ ...msg, receivedAt: performance.now() });
    }
  });
  const send = (commands: unknown[][]): Promise<Reply[]> => {
    const pending = commands.map((command) => {
      const id = nextId++;
      const { promise, resolve } = Promise.withResolvers<Reply>();
      const timer = setTimeout(() => resolve({ request_id: id, error: `timeout ${JSON.stringify(command)}` }), 5_000);
      waiting.set(id, (r) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(r);
      });
      return { id, command, promise };
    });
    const sentAt = performance.now();
    client.write(pending.map((p) => `${JSON.stringify({ command: p.command, request_id: p.id })}\n`).join(""));
    return Promise.all(pending.map((p) => p.promise.then((r) => ({ ...r, elapsedMs: (r.receivedAt ?? Infinity) - sentAt }))));
  };
  return { send, one: async (command: unknown[]) => (await send([command]))[0]! };
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

const SECTION_LINES = /disable-section|enable-section|Set property: pause/;

const launch = async (): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), "sf-osc-pause-"));
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
    "--no-terminal",
    "--osc=no",
    "--load-scripts=no",
    "--border=no",
    "--input-default-bindings=no",
    `--input-conf=${join(oscDir!, "input.conf")}`,
    `--osd-fonts-dir=${join(oscDir!, "tog4in1", "fonts")}`,
    `--script=${join(oscDir!, "tog4in1", "tog4in1.lua")}`,
    `--script=${oscScript}`,
    "--fullscreen",
    "--geometry=1920x1080+0+0",
    "--msg-level=all=debug",
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
  const wrapper = ["xvfb-run", "-a", "-s", "-screen 0 1920x1080x24"];
  console.info(`${TAG} launch bin=${target!.bin} kind=${target!.kind} osc=${oscDir}`);
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
  const probe = await connect(sock);
  while (Date.now() < deadline) {
    const r = await probe.one(["get_property", "duration"]);
    if (typeof r.data === "number") break;
    await sleep(100);
  }
  console.info(`${TAG} mpv ready pid=${mpv.pid}`);
  return h;
};

/** True while tog4in1's MBTN_LEFT binding is live: mpv lists a disabled section's bindings with priority -1. */
const oscInputEnabled = (bindings: unknown): boolean =>
  Array.isArray(bindings) &&
  (bindings as Binding[]).some((b) => b.section === OSC_INPUT_SECTION && b.key?.toUpperCase() === "MBTN_LEFT" && (b.priority ?? -1) >= 0);

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

describe.skipIf(!runnable)("tog4in1 OSC input section vs pause toggles (real mpv, fullscreen)", () => {
  it("keeps the OSC's MBTN_LEFT binding enabled across every pause / resume", async () => {
    const h = await launch();
    const ipc = await connect(h.sock);
    const logStart = readFileSync(h.logFile, "utf8").length;
    let disabledSamples = 0;
    let totalSamples = 0;
    let lateDisabled = 0;
    let minJudged = Infinity;
    const perToggle: string[] = [];

    for (let i = 0; i < TOGGLES; i++) {
      const pause = i % 2 === 0;
      // Reveal the OSC and wait until its input section is live: the toggle must start from "enabled".
      // tog4in1 only reveals on a move of at least `minmousemove` px: alternate the spot.
      await ipc.one(["mouse", i % 2 === 0 ? "960" : "900", "900"]);
      const revealDeadline = Date.now() + 5_000;
      let live = false;
      while (!live && Date.now() < revealDeadline) {
        live = oscInputEnabled((await ipc.one(["get_property", "input-bindings"])).data);
        if (!live) await sleep(20);
      }
      if (!live) console.error(`${TAG} OSC input never live before toggle ${i}\n${dumpLog(h, SECTION_LINES)}`);
      expect(live, `OSC input section never became enabled before toggle ${i}`).toBe(true);

      // The toggle and the sampling burst go out in ONE write.
      const replies = await ipc.send([
        ["set_property", "pause", pause],
        ...Array.from({ length: BURST }, () => ["get_property", "input-bindings"]),
      ]);
      const all = replies.slice(1);
      const judged = all.filter((r) => (r.elapsedMs ?? Infinity) <= JUDGE_WINDOW_MS);
      const bad = judged.filter((r) => !oscInputEnabled(r.data)).length;
      const late = all.length - judged.length;
      const lateBad = all.filter((r) => (r.elapsedMs ?? Infinity) > JUDGE_WINDOW_MS && !oscInputEnabled(r.data)).length;
      disabledSamples += bad;
      totalSamples += judged.length;
      lateDisabled += lateBad;
      minJudged = Math.min(minJudged, judged.length);
      const lastMs = Math.round(all.at(-1)?.elapsedMs ?? -1);
      perToggle.push(`${pause ? "pause" : "resume"}:${bad}/${judged.length} (late ${late}, late-disabled ${lateBad}, burst ${lastMs} ms)`);
      await sleep(150);
    }

    const tail = readFileSync(h.logFile, "utf8").slice(logStart);
    const inputCommands = tail.split("\n").filter((l) => SECTION_LINES.test(l) && /name="input"|pause/.test(l));
    console.info(`${TAG} judged samples (reply <= ${JUDGE_WINDOW_MS} ms) with the OSC input section disabled: ${disabledSamples}/${totalSamples}; disabled after the window (resume fade-out hide, not judged): ${lateDisabled}`);
    console.info(`${TAG} per toggle ${perToggle.join(" ")}`);
    console.info(`${TAG} input-section commands in the mpv log:\n${inputCommands.slice(0, 40).join("\n")}`);
    if (disabledSamples > 0 || minJudged < MIN_JUDGED_PER_TOGGLE) console.error(`${TAG} FAIL dump\n${dumpLog(h, SECTION_LINES)}`);
    expect(minJudged, `every toggle needs >= ${MIN_JUDGED_PER_TOGGLE} samples answered within ${JUDGE_WINDOW_MS} ms`).toBeGreaterThanOrEqual(MIN_JUDGED_PER_TOGGLE);
    expect(disabledSamples, "no sample may see the OSC input section disabled right after a pause toggle").toBe(0);
  }, 120_000);
});
