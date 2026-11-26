/**
 * @req MPV-PREV-01[badger-desktop]
 *
 * Seek-bar hover previews in the desktop player (Chris 2026-10-30: "players should be able to use the screenshots
 * generated at import"). Drives the REAL mpv with the REAL sf-select.lua + tog4in1.lua + sf.lua (the app's script
 * wiring) and plays the desktop main process's part over JSON IPC:
 *  - `sf-preview-sheets {width,height,intervalSeconds}` says the video has previews (null: it has none);
 *  - hovering the seekbar makes the OSC ask `sf-preview-hover <token> <seconds>` (a client-message on the socket);
 *  - the answer `sf-preview-picture {token,path,width,height}` (a raw BGRA file) is drawn above the hover time;
 *  - an answer to an older request is dropped; leaving the seekbar removes the picture;
 *  - without previews the seekbar looks exactly as today: no box, no request.
 *
 * Window screenshots are the proof (SF_PREVIEW_SHOTS_DIR keeps a copy). Skips (loudly) without a runnable mpv
 * bundle, xvfb-run or ffmpeg.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REAL_MEDIA_TESTS_ENV, realMediaTestsRequested, requireMediaBinary } from "@space/media-deps";
import { resolveExternalMpvTarget } from "../src/external";
import { resolveMpvOscScript, resolveMpvOscSelectScript } from "../src/index";

const TAG = "[osc-seek-preview]";

const target = process.platform === "linux" ? resolveExternalMpvTarget() : null;
const oscScript = resolveMpvOscScript();
const selectScript = resolveMpvOscSelectScript();
const oscDir = oscScript ? join(oscScript, "..") : null;
const xvfbRun = spawnSync("sh", ["-c", "command -v xvfb-run"]).status === 0;
const ffmpeg = spawnSync("sh", ["-c", "command -v ffmpeg"]).status === 0;
// Real-mpv pixels and timing: only in the dedicated media-real-test job (SF_REAL_MEDIA_TESTS=1, ci.yaml), never in a
// unit job on a loaded shared runner, where mpv stalls for seconds and its captures come back blank.
const realMedia = realMediaTestsRequested();
if (realMedia) {
  requireMediaBinary("mpv (shipped bundle) + sf.lua", Boolean(target && target.kind !== "fallback" && oscScript && selectScript));
  requireMediaBinary("xvfb-run", xvfbRun);
  requireMediaBinary("ffmpeg", ffmpeg);
}
const runnable = realMedia && Boolean(target && target.kind !== "fallback" && oscScript && selectScript && xvfbRun && ffmpeg);
if (!runnable) {
  console.warn(
    `${TAG} SKIP: ${REAL_MEDIA_TESTS_ENV}=${realMedia ? "1" : "unset"} platform=${process.platform} mpv=${target?.kind ?? "n/a"} xvfb-run=${xvfbRun} ffmpeg=${ffmpeg}`,
  );
}

// Real-clock waits: this drives a separate mpv process whose clock fake timers cannot control. Every wait is a
// bounded poll on an observable condition.
const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

type Harness = { dir: string; mpv: ChildProcess; logFile: string; sock: string };
type Reply = { request_id?: number; data?: unknown; error?: string };
type MpvEvent = { event: string; args?: string[] };
type LayoutElement = { x1: number; y1: number; x2: number; y2: number; visible: boolean };
type Layout = { osd_w: number; osd_h: number; osc_visible: boolean; elements: Record<string, LayoutElement> };
type Ipc = { send: (command: unknown[]) => Promise<Reply>; events: MpvEvent[] };

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
  const events: MpvEvent[] = [];
  client.on("data", (chunk) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as Reply & Partial<MpvEvent>;
      if (typeof msg.request_id === "number") waiting.get(msg.request_id)?.(msg);
      else if (typeof msg.event === "string") events.push(msg as MpvEvent);
    }
  });
  const send = async (command: unknown[]): Promise<Reply> => {
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
  return { send, events };
};

const dumpLog = (h: Harness): string => {
  try {
    const lines = readFileSync(h.logFile, "utf8").split("\n");
    return `--- mpv log (${h.logFile}) ---\n${lines.filter((l) => /sf-preview|overlay|rror/.test(l)).slice(-40).join("\n")}`;
  } catch (err) {
    return `(no mpv log: ${err instanceof Error ? err.message : String(err)})`;
  }
};

/** Same script wiring as packages/mpv/src/external.ts; a 2 min grey fixture, paused, fullscreen 1920x1080. */
const launch = async (): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), "sf-osc-preview-"));
  const sock = join(dir, "mpv.sock");
  const logFile = join(dir, "mpv.log");
  const fixture = join(dir, "fixture.mkv");
  const enc = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=gray:s=64x36:r=24:d=120", "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", fixture]);
  if (enc.status !== 0) throw new Error(`${TAG} fixture encode failed: ${enc.stderr?.toString()}`);
  const args = [
    "--no-config", "--force-window=yes", "--keep-open=yes", "--vo=x11", "--ao=null", "--hwdec=no", "--no-terminal",
    "--osc=no", "--load-scripts=no", "--border=no", "--input-default-bindings=no", "--pause",
    `--input-conf=${join(oscDir!, "input.conf")}`,
    `--osd-fonts-dir=${join(oscDir!, "tog4in1", "fonts")}`,
    `--script=${selectScript}`,
    `--script=${join(oscDir!, "tog4in1", "tog4in1.lua")}`,
    `--script=${oscScript}`,
    `--script-opts=osc-visibility=always,sf-actions_file=${join(dir, "actions.json")}`,
    "--fullscreen", "--geometry=1920x1080+0+0",
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
  const mpv = spawn("xvfb-run", ["-a", "-s", "-screen 0 1920x1080x24", target!.bin, ...args], { stdio: "ignore", detached: true, env });
  mpv.unref();
  const h: Harness = { dir, mpv, logFile, sock };
  live.push(h);
  console.info(`${TAG} launch bin=${target!.bin} log=${logFile}`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !existsSync(sock)) {
    if (mpv.exitCode !== null) throw new Error(`${TAG} mpv exited early code=${mpv.exitCode}\n${dumpLog(h)}`);
    await sleep(50);
  }
  if (!existsSync(sock)) throw new Error(`${TAG} mpv IPC socket never appeared\n${dumpLog(h)}`);
  return h;
};

afterEach(() => {
  for (const c of conns.splice(0)) c.destroy();
  for (const h of live.splice(0)) {
    spawnSync("pkill", ["-KILL", "-f", h.logFile]);
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

const readLayout = async (h: Harness, ipc: Ipc): Promise<Layout | null> => {
  const before = readFileSync(h.logFile, "utf8").split("\n").length;
  await ipc.send(["script-message", "sf-e2e-layout"]);
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const hit = readFileSync(h.logFile, "utf8").split("\n").slice(before - 1).find((l) => l.includes("[sf-e2e-layout] json "));
    if (hit) return JSON.parse(hit.slice(hit.indexOf("[sf-e2e-layout] json ") + "[sf-e2e-layout] json ".length)) as Layout;
    await sleep(50);
  }
  return null;
};

const waitSeekbar = async (h: Harness, ipc: Ipc): Promise<LayoutElement> => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const el = (await readLayout(h, ipc))?.elements.seekbar;
    if (el?.visible) {
      console.info(`${TAG} seekbar ${Math.round(el.x1)},${Math.round(el.y1)}-${Math.round(el.x2)},${Math.round(el.y2)}`);
      return el;
    }
    await sleep(200);
  }
  throw new Error(`${TAG} seekbar never visible\n${dumpLog(h)}`);
};

const waitLog = async (h: Harness, needle: string) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (readFileSync(h.logFile, "utf8").includes(needle)) return;
    await sleep(50);
  }
  throw new Error(`${TAG} log never had ${JSON.stringify(needle)}\n${dumpLog(h)}`);
};

/** The OSC's hover requests seen on the socket: [token, seconds]. */
const hoverRequests = (ipc: Ipc): Array<[number, number]> =>
  ipc.events
    .filter((e) => e.event === "client-message" && e.args?.[0] === "sf-preview-hover")
    .map((e) => [Number(e.args![1]), Number(e.args![2])]);

const waitHover = async (h: Harness, ipc: Ipc, label: string, ready: (r: Array<[number, number]>) => boolean) => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const requests = hoverRequests(ipc);
    if (ready(requests)) {
      console.info(`${TAG} ${label}: hover requests ${JSON.stringify(requests)}`);
      return requests;
    }
    await sleep(50);
  }
  throw new Error(`${TAG} ${label}: hover requests ${JSON.stringify(hoverRequests(ipc))}\n${dumpLog(h)}`);
};

type Shot = { w: number; h: number; data: Buffer };

/** Window screenshot (OSD px, video + controls + overlays as on screen) decoded to rgb24. */
const grab = async (h: Harness, ipc: Ipc, name: string): Promise<Shot> => {
  const file = join(h.dir, `${name}.png`);
  const reply = await ipc.send(["screenshot-to-file", file, "window"]);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !existsSync(file)) await sleep(50);
  if (!existsSync(file)) throw new Error(`${TAG} screenshot ${name} never written: ${JSON.stringify(reply)}\n${dumpLog(h)}`);
  await sleep(100); // the file appears before mpv finishes writing it
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
  const [w, hh] = probe.stdout.toString().trim().split(",").map(Number);
  const raw = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 << 20 });
  const keep = process.env.SF_PREVIEW_SHOTS_DIR;
  if (keep) copyFileSync(file, join(keep, `${name}.png`));
  console.info(`${TAG} screenshot ${name}: ${w}x${hh}${keep ? ` (copied to ${keep})` : ""}`);
  return { w: w!, h: hh!, data: raw.stdout };
};

type Box = { count: number; x1: number; y1: number; x2: number; y2: number };

/**
 * Pixels within `tol` of `rgb` in the band above the seekbar (where the picture goes), with their bounding box.
 * The window screenshot passes the overlay through mpv's colour pipeline (pure magenta reads back as 255,40,255).
 */
const find = (s: Shot, seekbar: LayoutElement, rgb: [number, number, number], tol = 48): Box => {
  const box: Box = { count: 0, x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
  for (let y = Math.max(0, Math.round(seekbar.y1) - 400); y < Math.round(seekbar.y1); y++) {
    for (let x = 0; x < s.w; x++) {
      const i = (y * s.w + x) * 3;
      if (Math.abs(s.data[i]! - rgb[0]) <= tol && Math.abs(s.data[i + 1]! - rgb[1]) <= tol && Math.abs(s.data[i + 2]! - rgb[2]) <= tol) {
        box.count += 1;
        box.x1 = Math.min(box.x1, x);
        box.y1 = Math.min(box.y1, y);
        box.x2 = Math.max(box.x2, x);
        box.y2 = Math.max(box.y2, y);
      }
    }
  }
  return box;
};

/** Pixels that differ from `base` in the band above the seekbar's top, up to `label` px above it (the hover time). */
const changedAbove = (a: Shot, b: Shot, seekbar: LayoutElement, label: number): number => {
  let changed = 0;
  for (let y = Math.max(0, Math.round(seekbar.y1) - 400); y < Math.round(seekbar.y1) - label; y++) {
    for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * 3;
      if (Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!) > 24) changed += 1;
    }
  }
  return changed;
};

const PW = 160;
const PH = 90;
const MAGENTA: [number, number, number] = [255, 0, 255];
const GREEN: [number, number, number] = [0, 255, 0];

/** A solid PWxPH raw BGRA picture, as the main process writes it. */
const writePicture = (h: Harness, name: string, [r, g, b]: [number, number, number]): string => {
  const file = join(h.dir, `${name}.bgra`);
  const px = Buffer.from([b, g, r, 255]);
  writeFileSync(file, Buffer.concat(Array.from({ length: PW * PH }, () => px)));
  return file;
};

const answer = (ipc: Ipc, token: number, path: string) =>
  ipc.send(["script-message", "sf-preview-picture", JSON.stringify({ token, path, width: PW, height: PH })]);

describe.skipIf(!runnable)("desktop seek-bar hover previews (MPV-PREV-01)", () => {
  it("hovering the seekbar asks for the picture and draws the answer above the hover time; stale answers are dropped", async () => {
    const h = await launch();
    const ipc = await connect(h.sock);
    const seekbar = await waitSeekbar(h, ipc);
    await ipc.send(["script-message", "sf-preview-sheets", JSON.stringify({ width: PW, height: PH, intervalSeconds: 5 })]);
    await waitLog(h, `[sf-preview] sheets ${PW}x${PH}`);

    const y = Math.round((seekbar.y1 + seekbar.y2) / 2);
    const x = Math.round(seekbar.x1 + (seekbar.x2 - seekbar.x1) / 2);
    await ipc.send(["mouse", x, y]);
    const [[token1, seconds1]] = (await waitHover(h, ipc, "hover middle", (r) => r.length >= 1)) as [[number, number]];
    // Halfway along a 2 min video.
    expect(seconds1).toBeGreaterThan(50);
    expect(seconds1).toBeLessThan(70);

    await answer(ipc, token1, writePicture(h, "magenta", MAGENTA));
    let shot = await grab(h, ipc, "preview-shown");
    let pic = find(shot, seekbar, MAGENTA);
    for (let i = 0; i < 20 && pic.count < PW * PH * 0.9; i++) {
      await sleep(100);
      shot = await grab(h, ipc, "preview-shown");
      pic = find(shot, seekbar, MAGENTA);
    }
    console.info(`${TAG} magenta picture ${JSON.stringify(pic)} pointer=${x},${y}`);
    expect(pic.count).toBeGreaterThanOrEqual(PW * PH * 0.9);
    // Its own size (the screenshot's colour conversion softens a pixel or two at each edge).
    expect(Math.abs(pic.x2 - pic.x1 + 1 - PW)).toBeLessThanOrEqual(4);
    expect(Math.abs(pic.y2 - pic.y1 + 1 - PH)).toBeLessThanOrEqual(4);
    // Centred on the pointer, above the seekbar, leaving room for the hover time below it.
    expect(Math.abs((pic.x1 + pic.x2) / 2 - x)).toBeLessThanOrEqual(2);
    expect(pic.y2).toBeLessThan(seekbar.y1 - 10);
    const white = find(shot, { ...seekbar, y1: seekbar.y1 }, [255, 255, 255], 40);
    console.info(`${TAG} white (hover time) ${JSON.stringify(white)}`);
    expect(white.count).toBeGreaterThan(0);
    expect(white.y1).toBeGreaterThan(pic.y2);

    // Moving to another picture slot sends a new request; an answer to the OLD one is dropped.
    await ipc.send(["mouse", Math.round(seekbar.x1 + (seekbar.x2 - seekbar.x1) * 0.8), y]);
    const moved = await waitHover(h, ipc, "hover 80%", (r) => r.length >= 2);
    expect(moved[1]![0]).toBeGreaterThan(token1);
    await answer(ipc, token1, writePicture(h, "green", GREEN));
    await waitLog(h, "[sf-preview] stale picture dropped");
    shot = await grab(h, ipc, "preview-stale-dropped");
    expect(find(shot, seekbar, GREEN).count).toBe(0);

    // Leaving the seekbar removes the picture and tells the app (seconds -1).
    await ipc.send(["mouse", x, Math.round(seekbar.y1) - 500]);
    await waitHover(h, ipc, "leave", (r) => r.at(-1)?.[1] === -1);
    let left = await grab(h, ipc, "preview-left");
    for (let i = 0; i < 20 && find(left, seekbar, MAGENTA).count > 0; i++) {
      await sleep(100);
      left = await grab(h, ipc, "preview-left");
    }
    expect(find(left, seekbar, MAGENTA).count).toBe(0);
  }, 90_000);

  it("confirms the picture it shows, keeps it when the same record is re-sent, and removes it on a null answer", async () => {
    const h = await launch();
    const ipc = await connect(h.sock);
    const seekbar = await waitSeekbar(h, ipc);
    const sheets = JSON.stringify({ width: PW, height: PH, intervalSeconds: 5 });
    await ipc.send(["script-message", "sf-preview-sheets", sheets]);
    await waitLog(h, `[sf-preview] sheets ${PW}x${PH}`);
    const y = Math.round((seekbar.y1 + seekbar.y2) / 2);
    const x = Math.round(seekbar.x1 + (seekbar.x2 - seekbar.x1) * 0.3);
    await ipc.send(["mouse", x, y]);
    const [[token1]] = (await waitHover(h, ipc, "hover 30%", (r) => r.length >= 1)) as [[number, number]];
    await answer(ipc, token1, writePicture(h, "magenta", MAGENTA));
    const shownMagenta = async (name: string) => {
      let shot = await grab(h, ipc, name);
      for (let i = 0; i < 20 && find(shot, seekbar, MAGENTA).count < PW * PH * 0.9; i++) {
        await sleep(100);
        shot = await grab(h, ipc, name);
      }
      return find(shot, seekbar, MAGENTA).count;
    };
    expect(await shownMagenta("confirm-shown")).toBeGreaterThanOrEqual(PW * PH * 0.9);
    // The OSC tells the app which picture it shows, so the app keeps that file.
    const confirmations = ipc.events
      .filter((e) => e.event === "client-message" && e.args?.[0] === "sf-preview-shown")
      .map((e) => Number(e.args![1]));
    console.info(`${TAG} sf-preview-shown ${JSON.stringify(confirmations)}`);
    expect(confirmations).toEqual([token1]);

    // A metadata re-send carries the same record: the picture stays, no leave (-1) is sent.
    await ipc.send(["script-message", "sf-preview-sheets", sheets]);
    await sleep(300);
    expect(await shownMagenta("same-record-resent")).toBeGreaterThanOrEqual(PW * PH * 0.9);
    expect(hoverRequests(ipc).map(([, seconds]) => seconds)).not.toContain(-1);

    // Another slot whose sheet cannot be shown: the app answers path null and the old (wrong) picture goes.
    await ipc.send(["mouse", Math.round(seekbar.x1 + (seekbar.x2 - seekbar.x1) * 0.8), y]);
    const moved = await waitHover(h, ipc, "hover 80%", (r) => r.length >= 2);
    const token2 = moved.at(-1)![0];
    await ipc.send(["script-message", "sf-preview-picture", JSON.stringify({ token: token2, path: null })]);
    let gone = await grab(h, ipc, "null-answer");
    for (let i = 0; i < 20 && find(gone, seekbar, MAGENTA).count > 0; i++) {
      await sleep(100);
      gone = await grab(h, ipc, "null-answer");
    }
    console.info(`${TAG} after null answer: magenta=${find(gone, seekbar, MAGENTA).count}`);
    expect(find(gone, seekbar, MAGENTA).count).toBe(0);
  }, 90_000);

  it("a video without previews: no request, nothing above the hover time", async () => {
    const h = await launch();
    const ipc = await connect(h.sock);
    const seekbar = await waitSeekbar(h, ipc);
    // The renderer sends null for a video without a record (or with a malformed one).
    await ipc.send(["script-message", "sf-preview-sheets", "null"]);
    await waitLog(h, "[sf-preview] sheets none");
    const y = Math.round((seekbar.y1 + seekbar.y2) / 2);
    const x = Math.round((seekbar.x1 + seekbar.x2) / 2);
    await ipc.send(["mouse", x, Math.round(seekbar.y1) - 500]);
    const before = await grab(h, ipc, "no-preview-before");
    await ipc.send(["mouse", x, y]);
    // The hover time shows (white text right above the seekbar) ...
    let shot = await grab(h, ipc, "no-preview-hover");
    for (let i = 0; i < 20 && find(shot, seekbar, [255, 255, 255], 40).count === 0; i++) {
      await sleep(100);
      shot = await grab(h, ipc, "no-preview-hover");
    }
    const white = find(shot, seekbar, [255, 255, 255], 40);
    console.info(`${TAG} no previews: hover time ${JSON.stringify(white)}`);
    expect(white.count).toBeGreaterThan(0);
    // ... and above it nothing changed: no box, no placeholder; no request was sent.
    const changed = changedAbove(shot, before, seekbar, Math.round(seekbar.y1 - white.y1) + 4);
    console.info(`${TAG} no previews: changed pixels above the hover time = ${changed}`);
    expect(changed).toBe(0);
    expect(hoverRequests(ipc)).toEqual([]);
  }, 90_000);

  // @req MPV-PREV-06[badger-desktop]
  it("a video whose previews are being prepared: the hint above the hover time, no request; the record replaces it", async () => {
    const h = await launch();
    const ipc = await connect(h.sock);
    const seekbar = await waitSeekbar(h, ipc);
    const hint = "Previews are being prepared";
    await ipc.send(["script-message", "sf-preview-sheets", JSON.stringify({ hint })]);
    await waitLog(h, `[sf-preview] sheets none (hint: ${hint})`);
    const y = Math.round((seekbar.y1 + seekbar.y2) / 2);
    const x = Math.round((seekbar.x1 + seekbar.x2) / 2);
    await ipc.send(["mouse", x, Math.round(seekbar.y1) - 500]);
    const before = await grab(h, ipc, "hint-before");
    // Scrub: the pointer moves along the seekbar, as when dragging.
    await ipc.send(["mouse", Math.round(seekbar.x1 + (seekbar.x2 - seekbar.x1) * 0.3), y]);
    await ipc.send(["mouse", x, y]);
    let shot = await grab(h, ipc, "hint-scrub");
    const labelGap = () => {
      const white = find(shot, seekbar, [255, 255, 255], 40);
      return white.count > 0 ? Math.round(seekbar.y1 - white.y1) : 0;
    };
    // The hover time sits right above the seekbar; the hint is a second white line above it.
    const hintPixels = () => changedAbove(shot, before, seekbar, 30);
    for (let i = 0; i < 20 && hintPixels() === 0; i++) {
      await sleep(100);
      shot = await grab(h, ipc, "hint-scrub");
    }
    const changed = hintPixels();
    console.info(`${TAG} hint: changed pixels more than 30 px above the seekbar = ${changed}, white top ${labelGap()} px above it`);
    expect(changed).toBeGreaterThan(200);
    // Short and unobtrusive: one line, no box the size of a picture.
    expect(changed).toBeLessThan(PW * PH);
    expect(labelGap()).toBeGreaterThan(30);
    expect(hoverRequests(ipc)).toEqual([]);

    // Leaving the seekbar removes it.
    await ipc.send(["mouse", x, Math.round(seekbar.y1) - 500]);
    let left = await grab(h, ipc, "hint-left");
    for (let i = 0; i < 20 && changedAbove(left, before, seekbar, 30) > 0; i++) {
      await sleep(100);
      left = await grab(h, ipc, "hint-left");
    }
    expect(changedAbove(left, before, seekbar, 30)).toBe(0);

    // The record arrives (the player picks it up): hovering asks for pictures again.
    await ipc.send(["script-message", "sf-preview-sheets", JSON.stringify({ width: PW, height: PH, intervalSeconds: 5 })]);
    await waitLog(h, `[sf-preview] sheets ${PW}x${PH}`);
    await ipc.send(["mouse", x, y]);
    await waitHover(h, ipc, "hover after record", (r) => r.length >= 1);
  }, 90_000);
});
