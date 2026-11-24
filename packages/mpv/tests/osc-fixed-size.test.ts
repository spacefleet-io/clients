/**
 * @req MPV-OSC-05[badger-desktop]
 * @bugfix osc-text-scales-with-window
 * @regression-proof
 *
 * MPV-OSC-05: the desktop player's controls keep one on-screen size whatever
 * the window size, and follow the display's HiDPI scale. A first Windows user
 * (Badger 0.1.0) saw the controls' text grow and shrink with the window. Pre-fix:
 *   - tog4in1 used 2.0 OSD px per layout unit windowed but 2.8 fullscreen, so
 *     the bar jumped 40 % on fullscreen, and ignored display-hidpi-scale;
 *   - mpv's console (the subtitle / audio / quality / chapter menus,
 *     `input.select`) scaled with the window height (its scale_with_window
 *     "auto" follows osd-scale-by-window, default yes: osd-height / 720);
 *   - the subtitle-download panel (sf-select.lua) was laid out on a fixed
 *     1280x720 canvas, so it stretched with the window;
 *   - (Chris 2026-11-13, Mac and Windows: "the font size on the player, as
 *     well as the ui size (buttons, etc.) seems to shrink when the screen
 *     shrinks") text subtitles and mpv's own messages followed the window
 *     height (mpv's sub-scale-by-window / osd-scale-by-window, default yes).
 *
 * Drives the REAL mpv with the REAL sf-select.lua + tog4in1.lua + sf.lua on
 * Xvfb, at several window sizes and at Xft.dpi 96 and 192 (display-hidpi-scale
 * 1 and 2), with the app's own scale arguments (buildExternalMpvArgs), and
 * measures in OSD pixels: tog4in1's controls (sf-e2e-layout), the console's
 * font scale (its scale with the window), the subtitle panel's width and a
 * subtitle line's height in a window screenshot. SF_OSC_FIXED_SIZE_SHOTS=<dir>
 * keeps the 1600x900 / 640x360 screenshots there.
 *
 * Skips (loudly) without a runnable mpv bundle, xvfb-run, xrdb or ffmpeg.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireMediaBinary } from "@space/media-deps";
import { buildExternalMpvArgs, resolveExternalMpvTarget } from "../src/external";
import { resolveMpvOscScript, resolveMpvOscSelectScript } from "../src/index";

const TAG = "[osc-fixed-size]";

const target = process.platform === "linux" ? resolveExternalMpvTarget() : null;
const oscScript = resolveMpvOscScript();
const selectScript = resolveMpvOscSelectScript();
const oscDir = oscScript ? join(oscScript, "..") : null;
const has = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const xvfbRun = has("xvfb-run");
const xrdb = has("xrdb");
const ffmpeg = has("ffmpeg");
requireMediaBinary("mpv (shipped bundle) + sf.lua", Boolean(target && target.kind !== "fallback" && oscScript && selectScript));
requireMediaBinary("xvfb-run", xvfbRun);
requireMediaBinary("xrdb", xrdb);
requireMediaBinary("ffmpeg", ffmpeg);
const runnable = Boolean(target && target.kind !== "fallback" && oscScript && selectScript && xvfbRun && xrdb && ffmpeg);
if (!runnable) {
  console.warn(
    `${TAG} SKIP: platform=${process.platform} mpv=${target?.kind ?? "n/a"} osc=${oscScript ?? "none"} select=${selectScript ?? "none"} xvfb-run=${xvfbRun} xrdb=${xrdb} ffmpeg=${ffmpeg}. Run \`bun run setup:binaries\` and install xvfb + xrdb + ffmpeg.`,
  );
}

// Real-clock waits: a separate mpv process. Every wait is a bounded poll.
const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

type Reply = { request_id?: number; data?: unknown; error?: string };
type Ipc = (command: unknown[]) => Promise<Reply>;
type Harness = { dir: string; mpv: ChildProcess; logFile: string; sock: string; label: string };
type LayoutElement = { x1: number; y1: number; x2: number; y2: number; visible: boolean };
type Layout = { osd_w: number; osd_h: number; ui_scale?: number; hidpi?: number; osc_visible: boolean; elements: Record<string, LayoutElement> };

const live: Harness[] = [];
const conns: Socket[] = [];

const connect = async (sock: string): Promise<Ipc> => {
  const client = createConnection(sock);
  conns.push(client);
  const connected = Promise.withResolvers<void>();
  client.once("connect", connected.resolve);
  client.once("error", connected.reject);
  await connected.promise;
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

const dumpLog = (h: Harness): string => {
  try {
    const lines = readFileSync(h.logFile, "utf8").split("\n");
    return `--- ${h.label} mpv log (${h.logFile}) ---\n${lines.filter((l) => /sf-e2e-layout|hidpi|osd-dimensions|console|rror|warn/i.test(l)).slice(-60).join("\n")}`;
  } catch (err) {
    return `(no mpv log: ${err instanceof Error ? err.message : String(err)})`;
  }
};

// The app's own scale wiring (MPV-OSC-05): --osd-scale-by-window=no, --sub-scale-by-window=no.
const APP_SCALE_ARGS = buildExternalMpvArgs({ url: null }).filter((a) => /^--(osd|sub)-scale/.test(a));

/** mpv + our three scripts (the app's wiring, packages/mpv/src/external.ts) on its own Xvfb at `dpi`. */
const launch = async (opts: { window: string; fullscreen?: boolean; dpi: number; subtitle?: boolean }): Promise<Harness & { ipc: Ipc }> => {
  const label = `${opts.fullscreen ? "fullscreen" : opts.window}@${opts.dpi}dpi`;
  const dir = mkdtempSync(join(tmpdir(), "sf-osc-fixed-size-"));
  const sock = join(dir, "mpv.sock");
  const logFile = join(dir, "mpv.log");
  const fixture = join(dir, "fixture.mkv");
  const enc = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=64x36:r=24:d=60", "-c:v", "libx264", "-preset", "ultrafast", fixture]);
  if (enc.status !== 0) throw new Error(`${TAG} fixture encode failed: ${enc.stderr?.toString()}`);
  const subtitle = join(dir, "subtitle.srt");
  if (opts.subtitle) writeFileSync(subtitle, "1\n00:00:00,000 --> 00:01:00,000\nSubtitle Hgy line\n");
  const args = [
    "--no-config", "--force-window=yes", "--keep-open=yes", "--vo=x11", "--ao=null", "--mute=yes", "--hwdec=no",
    "--no-terminal", "--osc=no", ...APP_SCALE_ARGS, "--load-scripts=no", "--border=no", "--input-default-bindings=no", "--pause",
    `--input-conf=${join(oscDir!, "input.conf")}`,
    `--osd-fonts-dir=${join(oscDir!, "tog4in1", "fonts")}`,
    `--script=${selectScript}`,
    `--script=${join(oscDir!, "tog4in1", "tog4in1.lua")}`,
    `--script=${oscScript}`,
    "--script-opts=osc-visibility=always",
    // Subtitles in pure green so their pixels are told apart from the controls (colour does not change size).
    ...(opts.subtitle ? [`--sub-file=${subtitle}`, "--sub-color=#00FF00"] : []),
    ...(opts.fullscreen ? ["--fullscreen", "--geometry=1920x1080+0+0"] : [`--geometry=${opts.window}+0+0`]),
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
  // mpv's x11 VO reads its HiDPI scale from the Xft.dpi resource (96 = 1; logs "Using Xft.dpi scale").
  // -noreset: Xvfb otherwise wipes the resource database when xrdb, its only client, disconnects.
  const script = `echo "Xft.dpi: ${opts.dpi}" | xrdb -nocpp -merge && exec "$0" "$@"`;
  console.info(`${TAG} ${label}: launch bin=${target!.bin} kind=${target!.kind}; mpv log file: ${logFile}`);
  const mpv = spawn("xvfb-run", ["-a", "-s", "-screen 0 1920x1080x24 -noreset", "sh", "-c", script, target!.bin, ...args], { stdio: "ignore", detached: true, env });
  mpv.unref();
  const h: Harness = { dir, mpv, logFile, sock, label };
  live.push(h);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !existsSync(sock)) {
    if (mpv.exitCode !== null) throw new Error(`${TAG} ${label}: mpv exited early code=${mpv.exitCode}\n${dumpLog(h)}`);
    await sleep(50);
  }
  if (!existsSync(sock)) throw new Error(`${TAG} ${label}: mpv IPC socket never appeared\n${dumpLog(h)}`);
  return { ...h, ipc: await connect(sock) };
};

const readLayout = async (h: Harness, ipc: Ipc): Promise<Layout | null> => {
  const before = readFileSync(h.logFile, "utf8").split("\n").length;
  await ipc(["script-message", "sf-e2e-layout"]);
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const hit = readFileSync(h.logFile, "utf8").split("\n").slice(before - 1).find((l) => l.includes("[sf-e2e-layout] json "));
    if (hit) return JSON.parse(hit.slice(hit.indexOf("[sf-e2e-layout] json ") + "[sf-e2e-layout] json ".length)) as Layout;
    await sleep(50);
  }
  return null;
};

/** The play button's height in OSD px once the OSC laid out at this window's size. */
const playButton = async (h: Harness, ipc: Ipc): Promise<{ height: number; layout: Layout }> => {
  const deadline = Date.now() + 15_000;
  let last: Layout | null = null;
  while (Date.now() < deadline) {
    const dims = (await ipc(["get_property", "osd-dimensions"])).data as { w?: number; h?: number } | undefined;
    last = await readLayout(h, ipc);
    const play = last?.elements.playpause;
    if (last && play?.visible && dims?.h === last.osd_h && last.osc_visible) {
      const height = play.y2 - play.y1;
      console.info(`${TAG} ${h.label}: osd=${last.osd_w}x${last.osd_h} hidpi=${last.hidpi} ui_scale=${last.ui_scale} playpause=${play.x1.toFixed(1)},${play.y1.toFixed(1)}-${play.x2.toFixed(1)},${play.y2.toFixed(1)} height=${height.toFixed(2)}`);
      return { height, layout: last };
    }
    await sleep(200);
  }
  throw new Error(`${TAG} ${h.label}: play button never laid out; last=${JSON.stringify(last)?.slice(0, 600)}\n${dumpLog(h)}`);
};

type Shot = { w: number; h: number; raw: Buffer; file: string };

/** A window screenshot (OSD px) decoded to rgb24. */
const grab = async (h: Harness, ipc: Ipc, name: string): Promise<Shot> => {
  const file = join(h.dir, `${name}.png`);
  await ipc(["screenshot-to-file", file, "window"]);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !existsSync(file)) await sleep(50);
  await sleep(100);
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
  const [w, hh] = probe.stdout.toString().trim().split(",").map(Number);
  const raw = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 << 20 }).stdout;
  return { w: w!, h: hh!, raw, file };
};

const isRgb = (s: Shot, x: number, y: number, rgb: readonly [number, number, number], tol: number): boolean => {
  const i = (y * s.w + x) * 3;
  return Math.abs(s.raw[i]! - rgb[0]) <= tol && Math.abs(s.raw[i + 1]! - rgb[1]) <= tol && Math.abs(s.raw[i + 2]! - rgb[2]) <= tol;
};

/** The subtitle panel's #1F1F22 sheet across rows just above the centre of a window screenshot: its widest span. */
const panelBounds = async (h: Harness, ipc: Ipc, text = "Looking for subtitles"): Promise<{ width: number; first: number; last: number; windowW: number }> => {
  await ipc(["script-message", "sf-subtitle-fetch-json", JSON.stringify({ panel: text, dismissable: true })]);
  await sleep(500);
  const shot = await grab(h, ipc, "panel");
  // The span from the sheet's first to its last pixel (glyphs inside don't shorten it).
  let best = { width: 0, first: -1, last: -1 };
  for (const dy of [-30, -26, -22]) {
    const y = Math.round(shot.h / 2 + dy);
    let first = -1, last = -1;
    for (let x = 0; x < shot.w; x++) {
      if (isRgb(shot, x, y, [0x1f, 0x1f, 0x22], 3)) { if (first < 0) first = x; last = x; }
    }
    const width = first < 0 ? 0 : last - first + 1;
    if (width > best.width) best = { width, first, last };
  }
  console.info(`${TAG} ${h.label}: screenshot ${shot.w}x${shot.h} ${shot.file}: subtitle panel sheet x=${best.first}..${best.last} width=${best.width}px`);
  return { ...best, windowW: shot.w };
};

const panelWidth = async (h: Harness, ipc: Ipc): Promise<number> => (await panelBounds(h, ipc)).width;

type PillRect = { left: number; top: number; right: number; bottom: number };

/** Arm sf.lua's intro pill (a non-auto intro marker over the play position) and return its published click rect. */
const armPill = async (h: Harness, ipc: Ipc): Promise<PillRect> => {
  await ipc(["script-message", "sf-playback-json", JSON.stringify({ markers: [{ type: "intro", startSeconds: 0, endSeconds: 50, autoSkip: false }] })]);
  await ipc(["seek", "10", "absolute", "exact"]);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const before = readFileSync(h.logFile, "utf8").split("\n").length;
    await ipc(["script-message", "sf-e2e-pill"]);
    await sleep(200);
    const line = readFileSync(h.logFile, "utf8").split("\n").slice(before - 1).find((l) => l.includes("[sf-e2e-pill] {"));
    if (line) {
      const p = JSON.parse(line.slice(line.indexOf("{"))) as { active: boolean; rect?: PillRect };
      if (p.active && p.rect) {
        console.info(`${TAG} ${h.label}: pill click rect ${JSON.stringify(p.rect)}`);
        return p.rect;
      }
    }
  }
  throw new Error(`${TAG} ${h.label}: the intro pill never became active\n${dumpLog(h)}`);
};

/**
 * Bounding box of the drawn pill's outline in the top half of a screenshot. sf.lua draws it with ASS
 * `\\3c&H57B3FF&` (BBGGRR: rgb 255,179,87), an amber that nothing else in that corner is (PLAY-SKIP-06).
 */
const drawnPill = (s: Shot): PillRect | null => {
  let box: PillRect | null = null;
  for (let y = 0; y < s.h / 2; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = (y * s.w + x) * 3;
      if (!(s.raw[i]! >= 190 && s.raw[i]! - s.raw[i + 2]! >= 80)) continue;
      box = box ? { left: Math.min(box.left, x), top: Math.min(box.top, y), right: Math.max(box.right, x), bottom: Math.max(box.bottom, y) } : { left: x, top: y, right: x, bottom: y };
    }
  }
  return box;
};

type Box = { x1: number; y1: number; x2: number; y2: number; w: number; h: number };

/** Bounding box of the screenshot pixels `match` accepts, or null. */
const box = (s: Shot, match: (r: number, g: number, b: number) => boolean): Box | null => {
  let x1 = Infinity, y1 = Infinity, x2 = -1, y2 = -1;
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = (y * s.w + x) * 3;
      if (!match(s.raw[i]!, s.raw[i + 1]!, s.raw[i + 2]!)) continue;
      x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y);
    }
  }
  return x2 < 0 ? null : { x1, y1, x2, y2, w: x2 - x1 + 1, h: y2 - y1 + 1 };
};

/** tog4in1's layout once it is laid out for this window's size, with the controls showing. */
const settledLayout = async (h: Harness, ipc: Ipc): Promise<Layout> => {
  const deadline = Date.now() + 15_000;
  let last: Layout | null = null;
  while (Date.now() < deadline) {
    const dims = (await ipc(["get_property", "osd-dimensions"])).data as { h?: number } | undefined;
    last = await readLayout(h, ipc);
    if (last?.osc_visible && last.elements.seekbar?.visible && dims?.h === last.osd_h) return last;
    await sleep(200);
  }
  throw new Error(`${TAG} ${h.label}: controls never laid out; last=${JSON.stringify(last)?.slice(0, 600)}\n${dumpLog(h)}`);
};

afterEach(() => {
  for (const c of conns.splice(0)) c.destroy();
  for (const h of live.splice(0)) {
    try {
      if (h.mpv.pid) process.kill(-h.mpv.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    rmSync(h.dir, { recursive: true, force: true });
  }
});

describe.skipIf(!runnable)("MPV-OSC-05: the desktop player's controls keep one on-screen size", () => {
  it("tog4in1: the play button is the same size windowed small, windowed large and fullscreen", async () => {
    const heights: Record<string, number> = {};
    for (const c of [{ window: "960x540" }, { window: "1600x900" }, { window: "1920x1080", fullscreen: true }]) {
      const h = await launch({ ...c, dpi: 96 });
      heights[h.label] = (await playButton(h, h.ipc)).height;
      for (const c2 of conns.splice(0)) c2.destroy();
      for (const l of live.splice(0)) {
        if (l.mpv.pid) process.kill(-l.mpv.pid, "SIGKILL");
        rmSync(l.dir, { recursive: true, force: true });
      }
    }
    console.info(`${TAG} play button heights (OSD px): ${JSON.stringify(heights)}`);
    const values = Object.values(heights);
    for (const [label, height] of Object.entries(heights)) {
      expect(Math.abs(height - values[0]!), `${label}: play button ${height} px vs ${values[0]} px in the 960x540 window`).toBeLessThanOrEqual(1);
    }
  }, 120_000);

  it("tog4in1: at display-hidpi-scale 2 the play button is twice as many OSD px (same physical size)", async () => {
    const one = await launch({ window: "1280x720", dpi: 96 });
    const at1 = await playButton(one, one.ipc);
    const two = await launch({ window: "1280x720", dpi: 192 });
    const hidpi = (await two.ipc(["get_property", "display-hidpi-scale"])).data;
    console.info(`${TAG} display-hidpi-scale at Xft.dpi 192: ${JSON.stringify(hidpi)}`);
    expect(hidpi, "Xvfb with Xft.dpi 192 gives mpv a HiDPI scale of 2").toBe(2);
    const at2 = await playButton(two, two.ipc);
    expect(Math.abs(at2.height - 2 * at1.height), `play button ${at2.height} px at scale 2 vs ${at1.height} px at scale 1`).toBeLessThanOrEqual(2);
  }, 120_000);

  it("track menus: the console does not scale with the window (HiDPI scale only)", async () => {
    const h = await launch({ window: "960x540", dpi: 96 });
    await playButton(h, h.ipc);
    const opts = (await h.ipc(["get_property", "script-opts"])).data as Record<string, string>;
    console.info(`${TAG} script-opts: ${JSON.stringify(opts)}`);
    expect(opts["console-scale_with_window"], "sf-select sets console-scale_with_window=no").toBe("no");
    expect((await h.ipc(["get_property", "osd-scale-by-window"])).data, "mpv's OSD text is not scaled by the window").toBe(false);
  }, 60_000);

  it("subtitle panel: the same width in a small and a large window, twice as wide at HiDPI 2", async () => {
    const widths: Record<string, number> = {};
    for (const c of [{ window: "960x540", dpi: 96 }, { window: "1600x900", dpi: 96 }, { window: "1600x900", dpi: 192 }]) {
      const h = await launch(c);
      await playButton(h, h.ipc);
      widths[h.label] = await panelWidth(h, h.ipc);
      for (const c2 of conns.splice(0)) c2.destroy();
      for (const l of live.splice(0)) {
        if (l.mpv.pid) process.kill(-l.mpv.pid, "SIGKILL");
        rmSync(l.dir, { recursive: true, force: true });
      }
    }
    console.info(`${TAG} subtitle panel widths: ${JSON.stringify(widths)}`);
    const small = widths["960x540@96dpi"]!;
    const large = widths["1600x900@96dpi"]!;
    const hidpi = widths["1600x900@192dpi"]!;
    expect(small, "the panel is drawn").toBeGreaterThan(100);
    expect(Math.abs(large - small), `panel ${large} px in 1600x900 vs ${small} px in 960x540`).toBeLessThanOrEqual(2);
    expect(Math.abs(hidpi - 2 * large), `panel ${hidpi} px at HiDPI 2 vs ${large} px at HiDPI 1`).toBeLessThanOrEqual(4);
  }, 120_000);

  it("subtitle panel: in a window narrower than the panel it narrows to fit, 16 logical px clear each side, text inside", async () => {
    const text = "Looking for subtitles in English, French and Dutch online";
    for (const c of [{ window: "480x270", dpi: 96, hidpi: 1 }, { window: "1000x720", dpi: 192, hidpi: 2 }]) {
      const h = await launch(c);
      await playButton(h, h.ipc);
      const b = await panelBounds(h, h.ipc, text);
      const want = b.windowW - 2 * 16 * c.hidpi;
      console.info(`${TAG} ${h.label}: narrow panel x=${b.first}..${b.last} width=${b.width} want ${want} (window ${b.windowW})`);
      expect(b.width, `${h.label}: the panel is drawn`).toBeGreaterThan(100);
      expect(Math.abs(b.width - want), `${h.label}: panel ${b.width} px, want window ${b.windowW} - 2x${16 * c.hidpi}`).toBeLessThanOrEqual(4);
      expect(b.first, `${h.label}: panel starts inside the window`).toBeGreaterThanOrEqual(16 * c.hidpi - 3);
      expect(b.last, `${h.label}: panel ends inside the window`).toBeLessThanOrEqual(b.windowW - 16 * c.hidpi + 2);
      // The rewrapped text stays on the sheet: no white glyph pixel beside it on the sheet's rows.
      const shot = await grab(h, h.ipc, "panel-text");
      const col = b.first + 3;
      const rows: number[] = [];
      for (let y = 0; y < shot.h; y++) if (isRgb(shot, col, y, [0x1f, 0x1f, 0x22], 3)) rows.push(y);
      let outside = 0;
      for (const y of rows) {
        for (let x = 0; x < shot.w; x++) {
          if ((x < b.first || x > b.last) && isRgb(shot, x, y, [255, 255, 255], 30)) outside += 1;
        }
      }
      console.info(`${TAG} ${h.label}: sheet rows ${rows[0]}..${rows.at(-1)}; white px beside the sheet=${outside}`);
      expect(rows.length, `${h.label}: sheet rows found`).toBeGreaterThan(40 * c.hidpi);
      expect(outside, `${h.label}: panel text spills past the sheet`).toBe(0);
      for (const c2 of conns.splice(0)) c2.destroy();
      for (const l of live.splice(0)) {
        if (l.mpv.pid) process.kill(-l.mpv.pid, "SIGKILL");
        rmSync(l.dir, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it("top pill: at HiDPI 1 and 2 the drawn pill and its click area are the same rect, twice the OSD px at 2", async () => {
    const sizes: Record<number, { w: number; h: number }> = {};
    for (const c of [{ dpi: 96, hidpi: 1 }, { dpi: 192, hidpi: 2 }]) {
      const h = await launch({ window: "1280x720", dpi: c.dpi });
      await playButton(h, h.ipc);
      const rect = await armPill(h, h.ipc);
      await sleep(300);
      const shot = await grab(h, h.ipc, "pill");
      const drawn = drawnPill(shot);
      console.info(`${TAG} ${h.label}: pill drawn ${JSON.stringify(drawn)} vs click rect ${JSON.stringify(rect)}`);
      expect(drawn, `${h.label}: the pill's outline is drawn`).not.toBeNull();
      // The 2 px (× hidpi) outline straddles the rect's edge; anti-aliasing adds a pixel.
      const tol = 2 * c.hidpi + 2;
      for (const side of ["left", "top", "right", "bottom"] as const) {
        expect(Math.abs(drawn![side] - rect[side]), `${h.label}: drawn ${side} ${drawn![side]} vs click ${side} ${rect[side]}`).toBeLessThanOrEqual(tol);
      }
      sizes[c.hidpi] = { w: rect.right - rect.left, h: rect.bottom - rect.top };
      for (const c2 of conns.splice(0)) c2.destroy();
      for (const l of live.splice(0)) {
        if (l.mpv.pid) process.kill(-l.mpv.pid, "SIGKILL");
        rmSync(l.dir, { recursive: true, force: true });
      }
    }
    console.info(`${TAG} pill click rect sizes: ${JSON.stringify(sizes)}`);
    expect(Math.abs(sizes[2]!.h - 2 * sizes[1]!.h), "pill height doubles at HiDPI 2").toBeLessThanOrEqual(1);
    expect(Math.abs(sizes[2]!.w - 2 * sizes[1]!.w), "pill width doubles at HiDPI 2").toBeLessThanOrEqual(1);
  }, 120_000);

  it("controls, title and a subtitle line are the same pixel size at 1600x900 and 640x360, twice at HiDPI 2", async () => {
    const shotsDir = process.env.SF_OSC_FIXED_SIZE_SHOTS?.trim();
    if (shotsDir) mkdirSync(shotsDir, { recursive: true });
    const sizes: Record<string, { elements: Record<string, number>; sub: Box }> = {};
    for (const c of [{ window: "1600x900", dpi: 96 }, { window: "640x360", dpi: 96 }, { window: "1600x900", dpi: 192 }]) {
      const h = await launch({ ...c, subtitle: true });
      const layout = await settledLayout(h, h.ipc);
      await sleep(500);
      const shot = await grab(h, h.ipc, "subtitle");
      if (shotsDir) copyFileSync(shot.file, join(shotsDir, `after-${c.window}-${c.dpi}dpi.png`));
      const sub = box(shot, (r, g, b) => g >= 180 && r <= 90 && b <= 90);
      const elements: Record<string, number> = {};
      for (const name of ["playpause", "back", "title", "tog_fs", "cy_sub", "volume", "seekbar"]) {
        const e = layout.elements[name];
        if (e?.visible) elements[name] = e.y2 - e.y1;
      }
      console.info(`${TAG} ${h.label}: screenshot ${shot.file} subtitle box ${JSON.stringify(sub)} element heights ${JSON.stringify(elements)}`);
      expect(sub, `${h.label}: the subtitle line is drawn`).not.toBeNull();
      sizes[h.label] = { elements, sub: sub! };
      for (const c2 of conns.splice(0)) c2.destroy();
      for (const l of live.splice(0)) {
        if (l.mpv.pid) process.kill(-l.mpv.pid, "SIGKILL");
        rmSync(l.dir, { recursive: true, force: true });
      }
    }
    const large = sizes["1600x900@96dpi"]!;
    const small = sizes["640x360@96dpi"]!;
    const hidpi = sizes["1600x900@192dpi"]!;
    for (const [name, height] of Object.entries(large.elements)) {
      expect(small.elements[name], `640x360: ${name} is shown`).toBeDefined();
      expect(Math.abs(small.elements[name]! - height), `${name}: ${small.elements[name]} px at 640x360 vs ${height} px at 1600x900`).toBeLessThanOrEqual(1);
      expect(Math.abs(hidpi.elements[name]! - 2 * height), `${name}: ${hidpi.elements[name]} px at HiDPI 2 vs ${height} px at 1`).toBeLessThanOrEqual(2);
    }
    expect(Math.abs(small.sub.h - large.sub.h), `subtitle ${small.sub.h} px tall at 640x360 vs ${large.sub.h} px at 1600x900`).toBeLessThanOrEqual(2);
    expect(Math.abs(small.sub.w - large.sub.w), `subtitle ${small.sub.w} px wide at 640x360 vs ${large.sub.w} px at 1600x900`).toBeLessThanOrEqual(3);
    expect(Math.abs(hidpi.sub.h - 2 * large.sub.h), `subtitle ${hidpi.sub.h} px at HiDPI 2 vs ${large.sub.h} px at 1`).toBeLessThanOrEqual(3);
  }, 180_000);

  it("small windows leave controls out in priority order; what stays keeps its full size and nothing overlaps", async () => {
    const full = await launch({ window: "1600x900", dpi: 96 });
    const fullLayout = await settledLayout(full, full.ipc);
    for (const c2 of conns.splice(0)) c2.destroy();
    for (const l of live.splice(0)) {
      if (l.mpv.pid) process.kill(-l.mpv.pid, "SIGKILL");
      rmSync(l.dir, { recursive: true, force: true });
    }
    const expectShown: Record<string, string[]> = {
      "640x360": ["playpause", "back", "title", "meta", "seekbar", "tc_left", "tc_right", "volume", "volume_slider", "cy_sub", "cy_audio", "cy_qual", "tog_fs"],
      "480x270": ["playpause", "back", "seekbar", "tc_left", "tc_right", "volume", "cy_sub", "cy_audio", "cy_qual", "tog_fs"],
      "320x180": ["seekbar", "cy_sub", "cy_audio", "tog_fs"],
    };
    for (const [window, wanted] of Object.entries(expectShown)) {
      const h = await launch({ window, dpi: 96 });
      const layout = await settledLayout(h, h.ipc);
      const shown = Object.entries(layout.elements).filter(([name, e]) => e.visible && name !== "transBg");
      console.info(`${TAG} ${h.label}: shown ${JSON.stringify(shown.map(([name]) => name).sort())}`);
      expect(shown.map(([name]) => name).sort(), `${h.label}: controls left in`).toEqual([...wanted].sort());
      for (const [name, e] of shown) {
        const ref = fullLayout.elements[name]!;
        expect(Math.abs(e.y2 - e.y1 - (ref.y2 - ref.y1)), `${h.label}: ${name} height vs full size`).toBeLessThanOrEqual(1);
        if (name !== "seekbar" && name !== "title" && name !== "meta") {
          expect(Math.abs(e.x2 - e.x1 - (ref.x2 - ref.x1)), `${h.label}: ${name} width vs full size`).toBeLessThanOrEqual(1);
        }
        expect(e.x1 >= -1 && e.y1 >= -1 && e.x2 <= layout.osd_w + 1 && e.y2 <= layout.osd_h + 1, `${h.label}: ${name} inside the window`).toBe(true);
      }
      for (let i = 0; i < shown.length; i++) {
        for (let j = i + 1; j < shown.length; j++) {
          const [an, a] = shown[i]!;
          const [bn, b] = shown[j]!;
          const overlap = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 1 && Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > 1;
          expect(overlap, `${h.label}: ${an} overlaps ${bn}`).toBe(false);
        }
      }
      for (const c2 of conns.splice(0)) c2.destroy();
      for (const l of live.splice(0)) {
        if (l.mpv.pid) process.kill(-l.mpv.pid, "SIGKILL");
        rmSync(l.dir, { recursive: true, force: true });
      }
    }
  }, 180_000);
});
