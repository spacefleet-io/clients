/**
 * @bugfix skip-intro-pill-click-swallowed-by-window-controls
 * @regression-proof
 *
 * Ultimate-stress finding P9 (#25): clicking the "Skip intro" pill did nothing
 * while the OSC was visible. tog4in1 re-enables its forced `window-controls`
 * input section on every render, so it always sits above sf.lua's forced
 * MBTN_LEFT binding; in fullscreen its top band (30 virtual px * 2.8 = 84 OSD
 * px) covers the pill (OSD y 28..86). The click went to
 * `tog4in1/__keybinding13` and no seek followed.
 *
 * This test drives the REAL mpv with the REAL tog4in1.lua + sf.lua, fullscreen
 * 1920x1080 under its own Xvfb, and clicks like the ultimate harness (IPC
 * `mouse`, `keydown MBTN_LEFT`, `keyup MBTN_LEFT`) at the pill's published hit
 * rect (it moves below the controls' top band while they show, PLAY-OVL-01):
 *   - pill click must seek to the intro end (150 s);
 *   - a click in the window-controls band OUTSIDE the pill must still go to
 *     tog4in1 and must not seek (we did not steal the band).
 * Pre-fix the pill click stays at ~60 s.
 *
 * Skips (loudly) without a runnable mpv or without xvfb-run.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireMediaBinary } from "@space/media-deps";
import { resolveExternalMpvTarget } from "../src/external";
import { resolveMpvOscScript } from "../src/index";

const TAG = "[sf-pill-click-routing]";
const INTRO_END = 150;

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
// stack, OSC render ticks, seeks) whose clock fake timers cannot control.
// Every wait is a bounded poll on an observable condition except the short
// move->down->up gaps, which mimic the harness click.
const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

type Harness = { dir: string; mpv: ChildProcess; logFile: string; sock: string };
const live: Harness[] = [];

const ipc = (sock: string, command: unknown[]): Promise<{ data?: unknown; error?: string }> => {
  const { promise, resolve, reject } = Promise.withResolvers<{ data?: unknown; error?: string }>();
  const client = createConnection(sock);
  let buf = "";
  const timer = setTimeout(() => {
    client.destroy();
    reject(new Error(`${TAG} ipc timeout ${JSON.stringify(command)}`));
  }, 5_000);
  client.on("connect", () => client.write(`${JSON.stringify({ command, request_id: 1 })}\n`));
  client.on("data", (chunk) => {
    buf += chunk.toString();
    for (const line of buf.split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { request_id?: number; data?: unknown; error?: string };
      if (msg.request_id === 1) {
        clearTimeout(timer);
        client.end();
        resolve(msg);
        return;
      }
    }
  });
  client.on("error", (err) => {
    clearTimeout(timer);
    reject(err);
  });
  return promise;
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

const ROUTING_LINES = /keydown|keyup|script-binding|sf-pill|sf-skip|seek|enable-section/;

const launch = async (): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), "sf-pill-click-"));
  const sock = join(dir, "mpv.sock");
  const logFile = join(dir, "mpv.log");
  // lavfi:// sources are not seekable; a 600 s 64x36 4 fps file is (~0.5 s to
  // encode, ~50 KB).
  const fixture = join(dir, "fixture.mkv");
  const enc = spawnSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=64x36:r=4:d=600",
    "-c:v", "libx264", "-preset", "ultrafast", "-g", "8", fixture,
  ]);
  if (enc.status !== 0) throw new Error(`${TAG} fixture encode failed: ${enc.stderr?.toString()}`);
  // Same input/script wiring as apps/badger external mpv launch (see the
  // ultimate run's mpv "Command line options" line).
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
  // Wait until playback has a duration (tog4in1 laid out, sf.lua loaded).
  while (Date.now() < deadline) {
    const r = await ipc(sock, ["get_property", "duration"]).catch(() => ({ data: undefined }));
    if (typeof r.data === "number") break;
    await sleep(100);
  }
  console.info(`${TAG} mpv ready pid=${mpv.pid}`);
  return h;
};

const timePos = async (h: Harness): Promise<number> => {
  const r = await ipc(h.sock, ["get_property", "time-pos"]);
  return typeof r.data === "number" ? r.data : Number.NaN;
};

/** Pause at 60 s with a non-auto intro marker 0..150 so the pill is shown. */
const armIntroPill = async (h: Harness) => {
  await ipc(h.sock, [
    "script-message",
    "sf-playback-json",
    JSON.stringify({ markers: [{ type: "intro", startSeconds: 0, endSeconds: INTRO_END, autoSkip: false }] }),
  ]);
  await ipc(h.sock, ["seek", "60", "absolute", "exact"]);
  await ipc(h.sock, ["set_property", "pause", true]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await ipc(h.sock, ["script-message", "sf-e2e-pill"]);
    await sleep(150);
    const pillLines = readFileSync(h.logFile, "utf8")
      .split("\n")
      .filter((l) => l.includes("[sf-e2e-pill] {"));
    const last = pillLines.at(-1);
    if (last?.includes('"active":true') && last.includes('"rect"')) {
      console.info(`${TAG} pill ready: ${last.slice(last.indexOf("{"))}`);
      return;
    }
  }
  throw new Error(`${TAG} pill never became active\n${dumpLog(h, ROUTING_LINES)}`);
};

/** Harness-identical click: move, wait a frame, MBTN_LEFT down/up. */
const click = async (h: Harness, x: number, y: number) => {
  console.info(`${TAG} click at ${x},${y}`);
  await ipc(h.sock, ["mouse", String(x), String(y)]);
  await sleep(150);
  await ipc(h.sock, ["keydown", "MBTN_LEFT"]);
  await sleep(120);
  await ipc(h.sock, ["keyup", "MBTN_LEFT"]);
};

afterEach(() => {
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

describe.skipIf(!runnable)("sf.lua pill click vs tog4in1 window-controls (real mpv, fullscreen)", () => {
  it("a click on the Skip intro pill where it is drawn seeks to the intro end", async () => {
    const h = await launch();
    await armIntroPill(h);
    const before = await timePos(h);
    console.info(`${TAG} time-pos before pill click=${before}`);
    // The move reveals the controls, and the pill moves below their top band
    // while they show (PLAY-OVL-01): click where it is drawn now, i.e. its
    // published hit rect, not a fixed spot.
    await ipc(h.sock, ["mouse", "215", "57"]);
    type PillRect = { active?: boolean; left?: number; top?: number; right?: number; bottom?: number };
    let rect: PillRect | null = null;
    const rectDeadline = Date.now() + 4_000;
    while (Date.now() < rectDeadline) {
      rect = (await ipc(h.sock, ["get_property", "user-data/sf/pill-rect"])).data as PillRect | null;
      if (rect?.active && (rect.top ?? 0) > 28) break;
      await sleep(100);
    }
    console.info(`${TAG} pill rect with the controls shown: ${JSON.stringify(rect)}`);
    expect(rect?.active, "pill shown").toBe(true);
    await click(h, Math.round((rect!.left! + rect!.right!) / 2), Math.round((rect!.top! + rect!.bottom!) / 2));
    let after = before;
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      after = await timePos(h);
      if (after >= INTRO_END - 0.5) break;
      await sleep(100);
    }
    console.info(`${TAG} time-pos after pill click=${after}`);
    if (!(after >= INTRO_END - 0.5)) console.error(`${TAG} FAIL dump\n${dumpLog(h, ROUTING_LINES)}`);
    expect(after, "pill click must seek to intro end").toBeGreaterThanOrEqual(INTRO_END - 0.5);
  }, 90_000);

  it("a click in the window-controls band outside the pill still goes to tog4in1 and does not seek", async () => {
    const h = await launch();
    await armIntroPill(h);
    const before = await timePos(h);
    const logBefore = readFileSync(h.logFile, "utf8").length;
    await click(h, 1000, 30);
    await sleep(800);
    const after = await timePos(h);
    const tail = readFileSync(h.logFile, "utf8").slice(logBefore);
    const routedToTog = /script-binding.*tog4in1\/__keybinding/.test(tail);
    const forwarded = tail.includes("forwarded MBTN_LEFT");
    console.info(`${TAG} band click: before=${before} after=${after} routedToTog=${routedToTog} forwarded=${forwarded}`);
    if (!routedToTog || forwarded || Math.abs(after - before) > 1) {
      console.error(`${TAG} FAIL dump\n${dumpLog(h, ROUTING_LINES)}`);
    }
    expect(routedToTog, "band click handled by tog4in1").toBe(true);
    expect(forwarded, "band click outside pill must not be forwarded to sf").toBe(false);
    expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
  }, 90_000);
});

// @bugfix player-drag-pauses @regression-proof @req MPV-CLICK-01
// Chris 2026-11-09 hand-try: "when I click and hold somewhere on the screen to
// move the player around it then registers it as a simple click when I let go
// which pauses the player". Moving the mouse 3 px with the button held starts
// mpv's window drag (begin-vo-dragging, --input-dragging-deadzone=3), which
// releases MBTN_LEFT as a CANCELED up. The window moves with the pointer, so
// the pointer barely moves inside it: the old 4 px / 0.5 s rule took that
// canceled up for a click. Here the drag starts the same way through IPC
// (button down, 4 px move), with no window manager needed.
const isPaused = async (h: Harness) => (await ipc(h.sock, ["get_property", "pause"])).data === true;

const pressOnPicture = async (h: Harness, opts: { holdMs: number; moveBy: number }) => {
  const x = 1500;
  const y = 500;
  console.info(`${TAG} press at ${x},${y} hold=${opts.holdMs}ms moveBy=${opts.moveBy}px`);
  await ipc(h.sock, ["mouse", String(x), String(y)]);
  await sleep(150);
  await ipc(h.sock, ["keydown", "MBTN_LEFT"]);
  if (opts.moveBy > 0) {
    await sleep(40);
    await ipc(h.sock, ["mouse", String(x + opts.moveBy), String(y)]);
  }
  await sleep(opts.holdMs);
  await ipc(h.sock, ["keyup", "MBTN_LEFT"]);
  await sleep(600);
};

const CLICK_LINES = /keydown|keyup|script-binding|begin-vo-dragging|sf-click|cycle/;

describe.skipIf(!runnable)("sf.lua click on the picture vs window drag (real mpv, fullscreen)", () => {
  it("a quick click on the picture pauses", async () => {
    const h = await launch();
    expect(await isPaused(h)).toBe(false);
    await pressOnPicture(h, { holdMs: 80, moveBy: 0 });
    const paused = await isPaused(h);
    console.info(`${TAG} after quick click paused=${paused}`);
    if (!paused) console.error(`${TAG} FAIL dump\n${dumpLog(h, CLICK_LINES)}`);
    expect(paused, "a real click toggles pause").toBe(true);
  }, 90_000);

  it("a press that starts a window drag does not pause", async () => {
    const h = await launch();
    await pressOnPicture(h, { holdMs: 80, moveBy: 4 });
    const tail = readFileSync(h.logFile, "utf8");
    const dragged = tail.includes("begin-vo-dragging");
    const paused = await isPaused(h);
    console.info(`${TAG} after drag: dragStarted=${dragged} paused=${paused}`);
    if (!dragged || paused) console.error(`${TAG} FAIL dump\n${dumpLog(h, CLICK_LINES)}`);
    expect(dragged, "mpv started its window drag").toBe(true);
    expect(paused, "a window drag must not pause").toBe(false);
  }, 90_000);

  it("a press held longer than 250 ms does not pause", async () => {
    const h = await launch();
    await pressOnPicture(h, { holdMs: 400, moveBy: 0 });
    const paused = await isPaused(h);
    console.info(`${TAG} after 400 ms hold paused=${paused}`);
    if (paused) console.error(`${TAG} FAIL dump\n${dumpLog(h, CLICK_LINES)}`);
    expect(paused, "a long press is not a click").toBe(false);
  }, 90_000);
});
