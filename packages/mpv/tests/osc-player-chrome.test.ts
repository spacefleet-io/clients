/**
 * @req PLAY-OVL-01[badger-desktop]
 * @req PLAY-OVL-02[badger-desktop]
 * @req PLAY-OVL-03[badger-desktop]
 * @req PLAY-CHAP-01[badger-desktop]
 * @req MPV-OSC-02[badger-desktop]
 * @req MPV-OSC-03[badger-desktop]
 * @req MPV-OSC-04[badger-desktop]
 * @req PLAY-OVL-05[badger-desktop]
 *
 * Desktop player overlay (Chris 2026-10-29): the external mpv keeps its own
 * control layout. What is playing shows top-left on every media, clipped
 * before the window controls. The volume stays bottom-left; Chapters (only
 * when the file has chapters; picking one jumps to its start), subtitles,
 * audio and quality sit bottom-right, left of the fullscreen button, in the
 * bar's grey. The previous / next buttons beside play/pause step between
 * playable EPISODES (hidden when there is none, never on a movie, and gone
 * while a switch is in flight so a double press switches once). The skip pill
 * moves below the title's band while the controls show, and subtitles move up
 * above the bottom bar while the controls show. The old chapter-skip buttons
 * (ch_prev / ch_next) and mpv's playlist buttons (pl_prev / pl_next) are gone.
 *
 * Drives the REAL mpv with the REAL sf-select.lua + tog4in1.lua + sf.lua (the
 * app's script wiring), fed the same script-messages the desktop renderer
 * sends (sf-chapters-json, sf-playback-json), then reads tog4in1's element
 * layout (sf-e2e-layout), clicks the buttons through JSON IPC and grabs window
 * screenshots (SF_CHROME_SHOTS_DIR keeps a copy of them).
 *
 * Skips (loudly) without a runnable mpv bundle, xvfb-run or ffmpeg.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireMediaBinary, writeToneWav } from "@space/media-deps";
import { buildExternalMpvArgs, resolveExternalMpvTarget } from "../src/external";
import { resolveMpvOscScript, resolveMpvOscSelectScript } from "../src/index";

const TAG = "[osc-player-chrome]";

const target = process.platform === "linux" ? resolveExternalMpvTarget() : null;
const oscScript = resolveMpvOscScript();
const selectScript = resolveMpvOscSelectScript();
const oscDir = oscScript ? join(oscScript, "..") : null;
const xvfbRun = spawnSync("sh", ["-c", "command -v xvfb-run"]).status === 0;
const ffmpeg = spawnSync("sh", ["-c", "command -v ffmpeg"]).status === 0;
requireMediaBinary("mpv (shipped bundle) + sf.lua", Boolean(target && target.kind !== "fallback" && oscScript && selectScript));
requireMediaBinary("xvfb-run", xvfbRun);
requireMediaBinary("ffmpeg", ffmpeg);
const runnable = Boolean(target && target.kind !== "fallback" && oscScript && selectScript && xvfbRun && ffmpeg);
if (!runnable) {
  console.warn(
    `${TAG} SKIP: platform=${process.platform} mpv=${target?.kind ?? "n/a"} osc=${oscScript ?? "none"} select=${selectScript ?? "none"} xvfb-run=${xvfbRun} ffmpeg=${ffmpeg}. Run \`bun run setup:binaries\` and install xvfb + ffmpeg.`,
  );
}

// Real-clock waits: this drives a separate mpv process whose clock fake timers
// cannot control. Every wait is a bounded poll on an observable condition.
const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

type Harness = { dir: string; mpv: ChildProcess; logFile: string; sock: string; actionsFile: string };
type Reply = { request_id?: number; data?: unknown; error?: string };
type LayoutElement = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  visible: boolean;
  enabled: boolean;
  off?: boolean;
  content?: string;
  font?: string;
  // How it is drawn (tog4in1 layout style): fill / outline / shadow colour, glow, size, alpha [fill, 2nd, outline, shadow].
  c1?: string;
  c3?: string;
  c4?: string;
  blur?: number;
  bord?: number;
  shad?: number;
  fs?: number;
  alpha?: number[];
  // MPV-OSC-03: radius (OSD px) of the round chip drawn behind a button, like the phone player's round buttons.
  chip_r?: number;
};
type Layout = { osd_w: number; osd_h: number; virt_per_osd_y?: number; osc_visible: boolean; elements: Record<string, LayoutElement> };
type Ipc = (command: unknown[]) => Promise<Reply>;

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

const RELEVANT = /sf-e2e-layout\]|sf-episode|sf-skip\] apply_playback_json|select-chapter|force-media-title|script-binding|sf-chapters|rror/;

const dumpLog = (h: Harness, filter: RegExp = RELEVANT): string => {
  try {
    const lines = readFileSync(h.logFile, "utf8").split("\n");
    return `--- mpv log (${h.logFile}) ---\n${lines.filter((l) => filter.test(l)).slice(-60).join("\n")}`;
  } catch (err) {
    return `(no mpv log: ${err instanceof Error ? err.message : String(err)})`;
  }
};

/** One green bottom-centre line for 2 min as ASS: libass draws it inside the picture (no black-bar margins), like PGS / VobSub. */
const ASS_FIXTURE = [
  "[Script Info]", "ScriptType: v4.00+", "PlayResX: 384", "PlayResY: 288", "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: Default,Inter,20,&H0000FF00,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1", "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:00.00,0:02:00.00,Default,,0,0,0,,Subtitle line", "",
].join("\n");

/**
 * One VobSub (dvd_subtitle) picture subtitle, written byte by byte (ffmpeg cannot turn text into
 * a picture subtitle): a solid green bar at the bottom of a 720x480 frame (rows 455-474), from 0 s
 * to the end. `<base>.sub` holds one 2048-byte MPEG-PS sector (pack header, private stream 1 PES
 * with substream 0x20 carrying the SPU, padding); `<base>.idx` the palette (entry 2 green) and index.
 */
const writeVobSub = (base: string): string => {
  const W = 120, H = 20, X = 300, Y = 455;
  // each line: one run to the end of the line in pixel value 1 (RLE code 0x0001)
  const field = Array.from({ length: H / 2 }, () => [0x00, 0x01]).flat();
  const ctrl = 4 + 2 * field.length;
  const last = ctrl + 24;
  const x2 = X + W - 1, y2 = Y + H - 1;
  const darea = [X >> 4, ((X & 0xf) << 4) | (x2 >> 8), x2 & 0xff, Y >> 4, ((Y & 0xf) << 4) | (y2 >> 8), y2 & 0xff];
  // start display; colours: value 1 = palette 2, value 0 = palette 0; contrast: value 1 opaque, value 0 clear; area; field offsets
  const show = [0, 0, last >> 8, last & 0xff, 0x01, 0x03, 0x00, 0x20, 0x04, 0x00, 0xf0, 0x05, ...darea, 0x06, 0, 4, (4 + field.length) >> 8, (4 + field.length) & 0xff, 0xff];
  const hide = [0xff, 0xff, last >> 8, last & 0xff, 0x02, 0xff]; // stop display after ~12 min
  const body = [...field, ...field, ...show, ...hide];
  const size = 4 + body.length;
  const spu = [size >> 8, size & 0xff, ctrl >> 8, ctrl & 0xff, ...body];
  const pes = [0x81, 0x80, 5, 0x21, 0x00, 0x01, 0x00, 0x01, 0x20, ...spu]; // PTS 0, substream 0x20
  const packet = [0, 0, 1, 0xba, 0x44, 0, 4, 0, 4, 1, 0x01, 0x89, 0xc3, 0xf8, 0, 0, 1, 0xbd, pes.length >> 8, pes.length & 0xff, ...pes];
  const pad = 2048 - packet.length - 6;
  writeFileSync(`${base}.sub`, Buffer.from([...packet, 0, 0, 1, 0xbe, pad >> 8, pad & 0xff, ...Array<number>(pad).fill(0xff)]));
  const palette = ["000000", "ffffff", "00ff00", ...Array<string>(13).fill("808080")].join(", ");
  writeFileSync(`${base}.idx`, `# VobSub index file, v7 (do not modify this line!)\nsize: 720x480\npalette: ${palette}\n\nid: en, index: 0\ntimestamp: 00:00:00:000, filepos: 000000000\n`);
  return `${base}.idx`;
};

/**
 * Production launch is borderless (`--border=no`), so the window controls are always there.
 * `tracks`: the fixture also carries an audio and a subtitle track (one green line for 2 min), so cy_audio / cy_sub are enabled.
 * `subFormat`: that subtitle track as SRT (default: libass may draw it in the black bars), ASS (drawn inside the picture)
 * or VobSub (a picture subtitle, like a DVD's or PGS: a green bar, placed in the picture).
 * `videoSize`: the fixture's frame size (default 64x36, 16:9); a wider one is letterboxed.
 * `window`: windowed size (default 1280x720) when not fullscreen.
 * `source`: play this instead of the encoded fixture (e.g. an endless lavfi stream, which has no duration).
 */
const launch = async (opts: { fullscreen?: boolean; tracks?: boolean; subFormat?: "srt" | "ass" | "vobsub"; videoSize?: string; window?: string; source?: string } = {}): Promise<Harness> => {
  const fullscreen = opts.fullscreen ?? true;
  const dir = mkdtempSync(join(tmpdir(), "sf-osc-chrome-"));
  const sock = join(dir, "mpv.sock");
  const logFile = join(dir, "mpv.log");
  const actionsFile = join(dir, "sf-mpv-osc-action.json");
  const fixture = join(dir, "fixture.mkv");
  const subFormat = opts.subFormat ?? "srt";
  let subFile = join(dir, `fixture.${subFormat}`);
  // The shipped ffmpeg has no `anullsrc`/`sine` source: the audio track is a 1 s wav, looped to the clip's length.
  const toneFile = join(dir, "tone.wav");
  if (opts.tracks) {
    if (subFormat === "vobsub") subFile = writeVobSub(join(dir, "fixture"));
    else writeFileSync(subFile, subFormat === "ass" ? ASS_FIXTURE : "1\n00:00:00,000 --> 00:02:00,000\n<font color=\"#00FF00\">Subtitle line</font>\n");
    writeToneWav(toneFile, { hz: 440, seconds: 1 });
  }
  if (!opts.source) {
    const enc = spawnSync("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", `color=c=gray:s=${opts.videoSize ?? "64x36"}:r=24:d=120`,
      ...(opts.tracks ? ["-stream_loop", "-1", "-i", toneFile, "-i", subFile, "-map", "0:v", "-map", "1:a", "-map", "2:s", "-c:a", "aac", "-c:s", subFormat === "vobsub" ? "copy" : subFormat, "-t", "120"] : []),
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", fixture,
    ]);
    if (enc.status !== 0) throw new Error(`${TAG} fixture encode failed: ${enc.stderr?.toString()}`);
  }
  console.info(`${TAG} fixture ${opts.source ?? fixture} tracks=${opts.tracks === true} subs=${subFormat} video=${opts.videoSize ?? "64x36"}`);
  // Same script wiring as packages/mpv/src/external.ts (sf-select, tog4in1, sf).
  const args = [
    "--no-config",
    "--force-window=yes",
    "--keep-open=yes",
    "--vo=x11",
    "--ao=null",
    "--mute=yes",
    "--hwdec=no",
    "--no-terminal",
    "--osc=no",
    // the app's text scale wiring (MPV-OSC-05): --osd-scale-by-window=no, --sub-scale-by-window=no
    ...buildExternalMpvArgs({ url: null }).filter((a) => /^--(osd|sub)-scale/.test(a)),
    "--load-scripts=no",
    "--border=no",
    "--input-default-bindings=no",
    "--pause",
    `--input-conf=${join(oscDir!, "input.conf")}`,
    `--osd-fonts-dir=${join(oscDir!, "tog4in1", "fonts")}`,
    `--script=${selectScript}`,
    `--script=${join(oscDir!, "tog4in1", "tog4in1.lua")}`,
    `--script=${oscScript}`,
    `--script-opts=osc-visibility=always,sf-actions_file=${actionsFile}`,
    ...(fullscreen ? ["--fullscreen", "--geometry=1920x1080+0+0"] : [`--geometry=${opts.window ?? "1280x720"}+0+0`]),
    `--log-file=${logFile}`,
    `--input-ipc-server=${sock}`,
    opts.source ?? fixture,
  ];
  const env = {
    ...process.env,
    ...(target!.kind === "bundle" && target!.libDirs.length > 0
      ? { LD_LIBRARY_PATH: [target!.libDirs.join(":"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
      : {}),
  };
  const wrapper = ["xvfb-run", "-a", "-s", "-screen 0 1920x1080x24"];
  console.info(`${TAG} launch bin=${target!.bin} kind=${target!.kind} osc=${oscDir} fullscreen=${fullscreen}`);
  console.info(`${TAG} mpv log file: ${logFile}`);
  const mpv = spawn(wrapper[0]!, [...wrapper.slice(1), target!.bin, ...args], { stdio: "ignore", detached: true, env });
  mpv.unref();
  const h: Harness = { dir, mpv, logFile, sock, actionsFile };
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

/** Ask tog4in1 for its layout and read the reply from the mpv log (the hook logs its JSON). */
const readLayout = async (h: Harness, ipc: Ipc): Promise<Layout | null> => {
  const before = readFileSync(h.logFile, "utf8").split("\n").length;
  await ipc(["script-message", "sf-e2e-layout"]);
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const lines = readFileSync(h.logFile, "utf8").split("\n");
    // only whole lines: the last element is still being written while it has no newline
    const hit = lines.slice(before - 1, -1).find((l) => l.includes("[sf-e2e-layout] json "));
    if (hit) return JSON.parse(hit.slice(hit.indexOf("[sf-e2e-layout] json ") + "[sf-e2e-layout] json ".length)) as Layout;
    await sleep(50);
  }
  return null;
};

const visible = (layout: Layout | null, name: string): LayoutElement | null => {
  const el = layout?.elements[name];
  return el && el.visible ? el : null;
};

/** Poll the layout until `ready(layout)` holds (the OSC re-inits on the next render after a property change). */
const waitLayout = async (h: Harness, ipc: Ipc, label: string, ready: (l: Layout) => boolean): Promise<Layout> => {
  const deadline = Date.now() + 15_000;
  let last: Layout | null = null;
  while (Date.now() < deadline) {
    last = await readLayout(h, ipc);
    if (last && ready(last)) {
      const summary = Object.entries(last.elements)
        .filter(([, e]) => e.visible)
        .map(([n, e]) => `${n}@${Math.round(e.x1)},${Math.round(e.y1)}-${Math.round(e.x2)},${Math.round(e.y2)}${e.content ? `"${e.content}"` : ""}`)
        .join(" ");
      console.info(`${TAG} ${label}: osd=${last.osd_w}x${last.osd_h} osc_visible=${last.osc_visible} visible=[${summary}]`);
      return last;
    }
    await sleep(200);
  }
  console.error(`${TAG} ${label}: layout never ready; last=${JSON.stringify(last)}\n${dumpLog(h)}`);
  throw new Error(`${TAG} ${label}: layout never ready`);
};

/** A click is a move, keydown, ~100 ms, keyup (JSON IPC `mouse … single` only gives a press). */
const click = async (ipc: Ipc, el: LayoutElement) => {
  const x = Math.round((el.x1 + el.x2) / 2);
  const y = Math.round((el.y1 + el.y2) / 2);
  await ipc(["mouse", x, y]);
  await sleep(150);
  await ipc(["keydown", "MBTN_LEFT"]);
  await sleep(100);
  await ipc(["keyup", "MBTN_LEFT"]);
  console.info(`${TAG} click at ${x},${y}`);
};

const waitActionFile = async (h: Harness, type: string): Promise<string> => {
  const deadline = Date.now() + 5_000;
  let content = "";
  while (Date.now() < deadline) {
    content = existsSync(h.actionsFile) ? readFileSync(h.actionsFile, "utf8") : "";
    if (content.includes(`"type":"${type}"`)) return content;
    await sleep(50);
  }
  console.error(`${TAG} action file never had type=${type}: ${JSON.stringify(content)}\n${dumpLog(h)}`);
  return content;
};

const playback = (extra: Record<string, unknown>) =>
  JSON.stringify({ markers: [], autoplayNextEpisode: true, autoSkipNextEpisode: false, fallbackCountdownSeconds: 15, ...extra });

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

const EPISODE_TITLE = "Lodgers · S1 E2 · The Lodger with the Spare Key";
const LONG_TITLE =
  "Lodgers · S1 E2 · The Lodger with the Spare Key, the Very Long Director's Cut Title That Never Fits on One Line of Any Screen at All";
const CHAPTERS = [
  { title: "Opening", startSeconds: 0, endSeconds: null, orderIndex: 0 },
  { title: "Part two", startSeconds: 40, endSeconds: null, orderIndex: 1 },
];

const box = (el: LayoutElement | null) =>
  el ? `${Math.round(el.x1)},${Math.round(el.y1)}-${Math.round(el.x2)},${Math.round(el.y2)}` : "hidden";

/**
 * Desktop layout (MPV-OSC-04, Chris 2026-11-09): the back arrow and title
 * top-left, no window controls; play/pause in the centre of the screen;
 * volume bottom-left; the bottom-right group reads, left to right, Chapters
 * (only when the file has chapters), subtitles, audio, quality, then
 * fullscreen, all on the volume's line below the seek bar.
 */
const expectDesktopLayout = (layout: Layout, label: string, withChapters: boolean) => {
  const { osd_w: w, osd_h: hgt } = layout;
  const names = withChapters ? ["chapters", "cy_sub", "cy_audio", "cy_qual"] : ["cy_sub", "cy_audio", "cy_qual"];
  const title = visible(layout, "title");
  const back = visible(layout, "back");
  const play = visible(layout, "playpause");
  const fs = visible(layout, "tog_fs");
  const volume = visible(layout, "volume");
  const seek = visible(layout, "seekbar");
  const group = names.map((n) => visible(layout, n));
  console.info(
    `${TAG} ${label} layout: back=${box(back)} title=${box(title)} volume=${box(volume)} playpause=${box(play)} ${names.map((n, i) => `${n}=${box(group[i]!)}`).join(" ")} tog_fs=${box(fs)} chapters=${box(visible(layout, "chapters"))}`,
  );
  expect(title, `${label}: title shown`).toBeTruthy();
  expect(back, `${label}: back arrow shown`).toBeTruthy();
  for (const gone of ["minimize", "maximize", "close"]) {
    expect(visible(layout, gone), `${label}: window control ${gone} dropped`).toBeNull();
  }
  expect(play && fs && volume && seek, `${label}: play/pause, fullscreen, volume and seek bar shown`).toBeTruthy();
  expect(back!.x1, `${label}: back arrow at the left edge`).toBeLessThan(w * 0.05);
  expect(title!.x1, `${label}: title right of the back arrow`).toBeGreaterThanOrEqual(back!.x2);
  expect(title!.y2, `${label}: title sits in the top band`).toBeLessThan(hgt * 0.15);

  const playMidX = (play!.x1 + play!.x2) / 2;
  const playMidY = (play!.y1 + play!.y2) / 2;
  expect(Math.abs(playMidX - w / 2), `${label}: play/pause centred horizontally`).toBeLessThan(w * 0.02);
  expect(Math.abs(playMidY - hgt / 2), `${label}: play/pause centred vertically`).toBeLessThan(hgt * 0.02);

  const rowMid = (volume!.y1 + volume!.y2) / 2;
  const rowHalf = (volume!.y2 - volume!.y1) / 2;
  expect(volume!.x2, `${label}: volume stays bottom-left`).toBeLessThan(w * 0.15);
  expect(volume!.y1, `${label}: volume below the seek bar`).toBeGreaterThanOrEqual(seek!.y2);
  names.forEach((n, i) => expect(group[i], `${label}: ${n} shown in the bottom-right group`).toBeTruthy());
  if (!withChapters) expect(visible(layout, "chapters"), `${label}: no Chapters button without chapters`).toBeNull();
  const els = group as LayoutElement[];
  for (let i = 0; i < els.length; i++) {
    const el = els[i]!;
    expect(Math.abs((el.y1 + el.y2) / 2 - rowMid), `${label}: ${names[i]} on the volume's line`).toBeLessThanOrEqual(rowHalf);
    expect(el.x1, `${label}: ${names[i]} in the right part of the bar`).toBeGreaterThan(w * 0.6);
    if (i > 0) expect(el.x1, `${label}: ${names[i]} right of ${names[i - 1]}`).toBeGreaterThanOrEqual(els[i - 1]!.x2);
  }
  const last = els.at(-1)!;
  expect(last.x2, `${label}: ${names.at(-1)} left of fullscreen`).toBeLessThanOrEqual(fs!.x1);
  expect(fs!.x1 - last.x2, `${label}: ${names.at(-1)} right beside fullscreen`).toBeLessThan(fs!.x2 - fs!.x1);
  for (const gone of ["ch_prev", "ch_next", "pl_prev", "pl_next"]) {
    expect(visible(layout, gone), `${label}: ${gone} must not be shown`).toBeNull();
  }
};

type Shot = { w: number; h: number; data: Buffer };

/** Window screenshot (OSD px, video + subtitles + controls as on screen) decoded to rgb24. */
const grab = async (h: Harness, ipc: Ipc, name: string): Promise<Shot> => {
  const file = join(h.dir, `${name}.png`);
  const reply = await ipc(["screenshot-to-file", file, "window"]);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !existsSync(file)) await sleep(50);
  if (!existsSync(file)) throw new Error(`${TAG} screenshot ${name} never written: ${JSON.stringify(reply)}\n${dumpLog(h)}`);
  await sleep(100);
  const probe = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]);
  const [w, hh] = probe.stdout.toString().trim().split(",").map(Number);
  const raw = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 64 << 20 });
  const keep = process.env.SF_CHROME_SHOTS_DIR;
  if (keep) copyFileSync(file, join(keep, `${name}.png`));
  console.info(`${TAG} screenshot ${name}: ${w}x${hh} ${file}${keep ? ` (copied to ${keep})` : ""}`);
  return { w: w!, h: hh!, data: raw.stdout };
};

type Rgb = [number, number, number];
type Rgba = { r: number; g: number; b: number; a: number; css: string };

/**
 * MPV-OSC-03: the phone player's theme, read from its own source
 * (`PlayerControls.tsx` DEFAULT_THEME; colours as `#rrggbb` or `rgba(r, g, b, a)`).
 */
const mobileTheme = () => {
  const file = fileURLToPath(new URL("../../mobile-mpv-playback/src/components/PlayerControls.tsx", import.meta.url));
  const src = readFileSync(file, "utf8");
  const block = src.match(/const DEFAULT_THEME[^{]*\{([\s\S]*?)\};/)?.[1];
  if (!block) throw new Error(`${TAG} DEFAULT_THEME not found in ${file}`);
  const color = (name: string): Rgba => {
    const css = block.match(new RegExp(`${name}:\\s*["']([^"']+)["']`))?.[1];
    if (!css) throw new Error(`${TAG} ${name} not found in DEFAULT_THEME`);
    const hex = css.match(/^#([0-9a-f]{6})$/i)?.[1];
    if (hex) return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1, css };
    const m = css.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/);
    if (!m) throw new Error(`${TAG} unparsed colour ${name}=${css}`);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Number(m[4]), css };
  };
  return {
    accent: color("accent"),
    // MPV-OSC-04 (the approved centre-controls design) replaces the phone's
    // chip and unplayed-track colours: centre chips rgba(21, 21, 23, 0.75),
    // the unplayed track white at 0.25.
    chromeBackground: { r: 21, g: 21, b: 23, a: 0.75, css: "rgba(21, 21, 23, 0.75)" } as Rgba,
    sheetBackground: color("sheetBackground"),
    unplayed: { r: 255, g: 255, b: 255, a: 0.25, css: "rgba(255, 255, 255, 0.25)" } as Rgba,
    // Player text is white (PlayerControls styles: color "#fff").
    text: { r: 255, g: 255, b: 255, a: 1, css: "#fff" } as Rgba,
  };
};

const rgb = (c: Rgba): Rgb => [c.r, c.g, c.b];
/** `c` (with its alpha) drawn over the opaque `under`. */
const blend = (c: Rgba, under: Rgb): Rgb => [
  Math.round(c.a * c.r + (1 - c.a) * under[0]),
  Math.round(c.a * c.g + (1 - c.a) * under[1]),
  Math.round(c.a * c.b + (1 - c.a) * under[2]),
];
const near = (a: Rgb, b: Rgb, tol: number) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);
const px = (s: Shot, x: number, y: number): Rgb => {
  const i = (Math.min(s.h - 1, Math.max(0, y)) * s.w + Math.min(s.w - 1, Math.max(0, x))) * 3;
  return [s.data[i]!, s.data[i + 1]!, s.data[i + 2]!];
};
const countNear = (s: Shot, want: Rgb, tol: number) => {
  let n = 0;
  for (let i = 0; i + 2 < Math.min(s.data.length, s.w * s.h * 3); i += 3) {
    if (Math.abs(s.data[i]! - want[0]) <= tol && Math.abs(s.data[i + 1]! - want[1]) <= tol && Math.abs(s.data[i + 2]! - want[2]) <= tol) n++;
  }
  return n;
};

/** Bounding box of the green subtitle line's pixels (the fixture's `<font color="#00FF00">`), or null. */
const greenBox = (s: Shot) => {
  let x1 = Infinity, y1 = Infinity, x2 = -1, y2 = -1;
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      const i = (y * s.w + x) * 3;
      if (s.data[i]! < 90 && s.data[i + 1]! > 180 && s.data[i + 2]! < 90) {
        x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y);
      }
    }
  }
  return x2 < 0 ? null : { x1, y1, x2, y2 };
};

type PillRect = { active?: boolean; left?: number; top?: number; right?: number; bottom?: number };

/** Poll sf.lua's published pill hit rect (OSD px, the rect it draws and hit-tests) until `ready`. */
const waitPill = async (h: Harness, ipc: Ipc, label: string, ready: (r: PillRect) => boolean): Promise<PillRect> => {
  const deadline = Date.now() + 10_000;
  let last: PillRect | null = null;
  while (Date.now() < deadline) {
    last = (await ipc(["get_property", "user-data/sf/pill-rect"])).data as PillRect | null;
    if (last && ready(last)) {
      console.info(`${TAG} ${label}: pill rect ${JSON.stringify(last)}`);
      return last;
    }
    await sleep(100);
  }
  console.error(`${TAG} ${label}: pill never ready; last=${JSON.stringify(last)}\n${dumpLog(h, /sf-pill|sf-skip|osc-top-band|rror/)}`);
  throw new Error(`${TAG} ${label}: pill never ready`);
};

/** Wait until mpv's console (the chapter picker behind sf-select) is open AND owns the keyboard. */
const waitPickerKeys = async (h: Harness, ipc: Ipc): Promise<boolean> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const open = (await ipc(["get_property", "user-data/mpv/console/open"])).data === true;
    const bindings = (await ipc(["get_property", "input-bindings"])).data as { section?: string }[] | undefined;
    const keys = Array.isArray(bindings) && bindings.some((b) => b.section === "input_forced_console");
    if (open && keys) return true;
    await sleep(50);
  }
  console.error(`${TAG} chapter picker never took the keyboard\n${dumpLog(h)}`);
  return false;
};

/** Poll sub-pos until `ready` holds (logs every poll); returns the last value read. */
const waitSubPos = async (h: Harness, ipc: Ipc, label: string, ready: (p: unknown) => boolean, timeoutMs = 5_000): Promise<number> => {
  const deadline = Date.now() + timeoutMs;
  let pos: unknown = (await ipc(["get_property", "sub-pos"])).data;
  let polls = 1;
  console.info(`${TAG} ${label}: poll ${polls} sub-pos=${String(pos)}`);
  while (!ready(pos) && Date.now() < deadline) {
    await sleep(100);
    pos = (await ipc(["get_property", "sub-pos"])).data;
    polls++;
    console.info(`${TAG} ${label}: poll ${polls} sub-pos=${String(pos)}`);
  }
  if (!ready(pos)) console.error(`${TAG} ${label}: sub-pos never ready after ${polls} polls; last=${String(pos)}\n${dumpLog(h, /sf-subs|rror/)}`);
  return pos as number;
};

/**
 * The auto-hide users hit: visibility auto, the pointer moves out to the top-left
 * corner, the hide timeout runs out and the fade-out ends in osc_visible(false).
 * Polls sf-e2e-layout (logging every poll) until it reports osc_visible false.
 */
const autoHide = async (h: Harness, ipc: Ipc, label: string): Promise<Layout> => {
  await ipc(["script-message", "osc-visibility", "auto"]);
  const moved = await ipc(["mouse", 0, 0]);
  console.info(`${TAG} ${label}: osc-visibility auto, mouse 0,0 -> ${JSON.stringify(moved)}`);
  const deadline = Date.now() + 10_000;
  let last: Layout | null = null;
  let polls = 0;
  while (Date.now() < deadline) {
    last = await readLayout(h, ipc);
    polls++;
    const pos = (await ipc(["get_property", "sub-pos"])).data;
    console.info(`${TAG} ${label}: poll ${polls} osc_visible=${String(last?.osc_visible)} sub-pos=${String(pos)}`);
    if (last && last.osc_visible === false) return last;
    await sleep(200);
  }
  console.error(`${TAG} ${label}: controls never auto-hid after ${polls} polls; last=${JSON.stringify(last)}\n${dumpLog(h, /sf-subs|sf-e2e-layout\] osd|rror/)}`);
  throw new Error(`${TAG} ${label}: controls never auto-hid`);
};

describe.skipIf(!runnable)("desktop player overlay: title, Chapters button, episode buttons (real mpv)", () => {
  it("episode with chapters: title top-left, bottom-right group, prev/next step episodes, Chapters jumps to the picked chapter", async () => {
    const h = await launch();
    const ipc = await connect(h.sock);
    await ipc(["script-message", "sf-chapters-json", JSON.stringify(CHAPTERS)]);
    const episodePayload = playback({
      title: EPISODE_TITLE,
      nextEpisode: { id: "ep-3", label: "S1E03 - The Lodger with the Thumb" },
      previousEpisode: { id: "ep-1", label: "S1E01 - The New Lodger" },
    });
    await ipc(["script-message", "sf-playback-json", episodePayload]);
    const layout = await waitLayout(h, ipc, "episode", (l) =>
      Boolean(visible(l, "chapters") && visible(l, "ep_next") && visible(l, "title")?.content === EPISODE_TITLE));

    const title = visible(layout, "title")!;
    expect(title.content, "what's playing line").toBe(EPISODE_TITLE);
    expectDesktopLayout(layout, "episode fullscreen", true);
    const chapters = visible(layout, "chapters")!;
    // No audio track in this fixture: cy_audio is disabled and drawn dimmer than the enabled fullscreen button.
    const audio = layout.elements.cy_audio!;
    const fsAlpha = visible(layout, "tog_fs")!.alpha?.[0];
    console.info(`${TAG} disabled cy_audio alpha=${JSON.stringify(audio.alpha)} enabled=${audio.enabled} tog_fs alpha=${fsAlpha}`);
    expect(audio.enabled, "cy_audio disabled without an audio track").toBe(false);
    expect(audio.alpha?.[0], "disabled cy_audio drawn dimmer than the fullscreen button").toBeGreaterThan(fsAlpha!);
    // #2500, PLAY-SUBGET-05[badger-desktop]: no subtitle track either, yet the subtitles button is never greyed.
    const sub = layout.elements.cy_sub!;
    console.info(`${TAG} cy_sub without a subtitle track enabled=${sub.enabled} off=${sub.off} alpha=${JSON.stringify(sub.alpha)}`);
    expect(sub.enabled, "cy_sub enabled without a subtitle track (#2500)").toBe(true);
    expect(sub.off, "cy_sub not drawn off").toBeFalsy();

    const prev = visible(layout, "ep_prev")!;
    const next = visible(layout, "ep_next")!;
    const play = visible(layout, "playpause")!;
    expect(prev, "previous-episode button").toBeTruthy();
    expect(prev.x2, "previous left of play/pause").toBeLessThanOrEqual(play.x1);
    expect(next.x1, "next right of play/pause").toBeGreaterThanOrEqual(play.x2);
    expect(next.x2, "next stays left of the bottom-right group").toBeLessThan(chapters.x1);
    // The play / episode / Chapters icons are ASS vector drawings (MPV-OSC-03),
    // not icon-font code points that come out as other icons in the wrong font
    // (ep_next once looked like pause).
    const contents = { playpause: play.content, ep_prev: prev.content, ep_next: next.content, chapters: chapters.content };
    console.info(`${TAG} icon contents ${JSON.stringify(contents)}`);
    for (const [name, content] of Object.entries(contents)) expect(content ?? "", `${name} drawn icon`).toContain("\\p1");

    await click(ipc, prev);
    const prevAction = await waitActionFile(h, "previous_episode");
    console.info(`${TAG} after ep_prev click action file=${prevAction}`);
    expect(prevAction).toContain('"type":"previous_episode"');
    // The switch is in flight: both buttons leave until the next episode's payload.
    const switching = await waitLayout(h, ipc, "switching", (l) => !visible(l, "ep_prev") && !visible(l, "ep_next"));
    expect(visible(switching, "ep_prev"), "previous hidden while switching").toBeNull();
    await click(ipc, prev);
    await sleep(600);
    const writes = readFileSync(h.logFile, "utf8").split("\n").filter((l) => l.includes("[sf-episode] wrote osc action")).length;
    console.info(`${TAG} osc action writes after a second click on the old previous spot: ${writes}`);
    expect(writes, "a second click while switching writes nothing").toBe(1);

    await ipc(["script-message", "sf-playback-json", episodePayload]);
    const back = await waitLayout(h, ipc, "next payload", (l) => Boolean(visible(l, "ep_prev") && visible(l, "ep_next")));
    await click(ipc, visible(back, "ep_next")!);
    const nextAction = await waitActionFile(h, "next_episode");
    console.info(`${TAG} after ep_next click action file=${nextAction}`);
    expect(nextAction).toContain('"type":"next_episode"');
    // @bugfix @regression-proof #2473 #2487 #2488: the action carries the place in the episode
    // left (mpv's time-pos), which the app saves before it switches (PLAY-RESUME-02).
    const leftAt = (JSON.parse(nextAction) as { timePos?: unknown }).timePos;
    console.info(`${TAG} next_episode timePos=${String(leftAt)}`);
    expect(typeof leftAt, "next_episode carries timePos").toBe("number");

    // Last: the picker (mpv's console list) takes the keyboard and mouse once open.
    const logBefore = readFileSync(h.logFile, "utf8").length;
    const before = (await ipc(["get_property", "time-pos"])).data;
    await click(ipc, visible(back, "chapters")!);
    const opened = await waitPickerKeys(h, ipc);
    const clickLog = readFileSync(h.logFile, "utf8").slice(logBefore).split("\n").filter((l) => RELEVANT.test(l) || /console|select/.test(l));
    console.info(`${TAG} after chapters click: picker ready=${opened} time-pos=${String(before)}\n${clickLog.slice(-20).join("\n")}`);
    expect(opened, "Chapters button opens the chapter picker (sf_select/select-chapter)").toBe(true);

    // PLAY-CHAP-01: the picker opens on the current chapter (Opening); DOWN + ENTER picks "Part two" (40 s).
    await ipc(["keypress", "DOWN"]);
    await sleep(150);
    await ipc(["keypress", "ENTER"]);
    const deadline = Date.now() + 5_000;
    let pos: unknown = null;
    while (Date.now() < deadline) {
      pos = (await ipc(["get_property", "time-pos"])).data;
      if (typeof pos === "number" && Math.abs(pos - 40) <= 1) break;
      await sleep(100);
    }
    const chapter = (await ipc(["get_property", "chapter"])).data;
    console.info(`${TAG} after picking row 2: time-pos=${String(pos)} chapter=${String(chapter)}`);
    if (typeof pos !== "number" || Math.abs(pos - 40) > 1) console.error(`${TAG} chapter jump missed\n${dumpLog(h)}`);
    expect(pos, "picking Part two jumps to its start").toBeTypeOf("number");
    expect(Math.abs((pos as number) - 40), "time-pos lands on Part two's start (40 s)").toBeLessThanOrEqual(1);
  }, 90_000);

  it("a double previous (two deliveries before the switch) writes one action and hides both buttons", async () => {
    const h = await launch();
    const ipc = await connect(h.sock);
    await ipc(["script-message", "sf-playback-json", playback({
      title: "Lodgers · S1 E5",
      nextEpisode: { id: "ep-6", label: "S1E06" },
      previousEpisode: { id: "ep-4", label: "S1E04" },
    })]);
    await waitLayout(h, ipc, "S1E5", (l) => Boolean(visible(l, "ep_prev") && visible(l, "ep_next")));
    await ipc(["script-message-to", "sf", "sf-episode-nav", "previous"]);
    await ipc(["script-message-to", "sf", "sf-episode-nav", "previous"]);
    await waitActionFile(h, "previous_episode");
    await sleep(600);
    const writes = readFileSync(h.logFile, "utf8").split("\n").filter((l) => l.includes("[sf-episode] wrote osc action previous_episode")).length;
    const nav = (await ipc(["get_property", "user-data/sf/episode-nav"])).data as { hasPrevious?: boolean; hasNext?: boolean } | null;
    console.info(`${TAG} double previous: writes=${writes} episode-nav=${JSON.stringify(nav)}\n${dumpLog(h, /sf-episode/)}`);
    expect(writes, "one switch for a double press").toBe(1);
    expect(nav?.hasPrevious, "previous gone until the next payload").toBe(false);
    expect(nav?.hasNext, "next gone until the next payload").toBe(false);
    const after = await waitLayout(h, ipc, "after double previous", (l) => !visible(l, "ep_prev") && !visible(l, "ep_next"));
    expect(visible(after, "ep_next"), "next button hidden while switching").toBeNull();
  }, 90_000);

  for (const fullscreen of [false, true]) {
    const mode = fullscreen ? "fullscreen" : "windowed";
    it(`long title (${mode}): clipped before the window controls`, async () => {
      const h = await launch({ fullscreen });
      const ipc = await connect(h.sock);
      await ipc(["script-message", "sf-chapters-json", JSON.stringify(CHAPTERS)]);
      await ipc(["script-message", "sf-playback-json", playback({ title: LONG_TITLE, nextEpisode: null, previousEpisode: null })]);
      const layout = await waitLayout(h, ipc, `long title ${mode}`, (l) =>
        Boolean(visible(l, "chapters") && visible(l, "title")?.content === LONG_TITLE));
      expectDesktopLayout(layout, `long title ${mode}`, true);
    }, 90_000);

    it(`skip pill (${mode}): below the title while the controls show, back at the top when they hide`, async () => {
      const h = await launch({ fullscreen });
      const ipc = await connect(h.sock);
      await ipc(["script-message", "sf-playback-json", playback({
        title: EPISODE_TITLE,
        nextEpisode: null,
        previousEpisode: null,
        markers: [{ type: "intro", startSeconds: 0, endSeconds: 60, autoSkip: false }],
      })]);
      const layout = await waitLayout(h, ipc, `pill ${mode}`, (l) => l.osc_visible && visible(l, "title")?.content === EPISODE_TITLE);
      const title = visible(layout, "title")!;
      const shown = await waitPill(h, ipc, `pill ${mode} controls shown`, (r) => r.active === true);
      const overlaps = shown.left! < title.x2 && shown.right! > title.x1 && shown.top! < title.y2 && shown.bottom! > title.y1;
      console.info(`${TAG} pill ${mode}: title=${box(title)} pill=${shown.left},${shown.top}-${shown.right},${shown.bottom} overlaps=${overlaps}`);
      expect(overlaps, `pill must not cover the title (${mode})`).toBe(false);
      expect(shown.top!, "pill below the top band").toBeGreaterThanOrEqual(title.y2);

      await ipc(["script-message", "osc-visibility", "never"]);
      const hidden = await waitPill(h, ipc, `pill ${mode} controls hidden`, (r) => r.active === true && r.top === 28);
      expect(hidden.top, "pill keeps its usual top-left place without controls").toBe(28);
    }, 90_000);
  }

  /**
   * Desktop look (Chris 2026-10-29), as restyled by MPV-OSC-03: Chapters,
   * subtitles, audio and quality are drawn like fullscreen (fill / outline /
   * shadow colour, alpha, outline, shadow, glow): white on a round chip of the
   * same size, like the phone's top-right buttons. Chapters is the drawn ≡.
   * The title carries a thin dark outline, kept cheap (sw OSD blends the glow).
   */
  it("bar look: Chapters, subtitles, audio and quality are drawn like fullscreen; the title has a dark outline", async () => {
    const h = await launch({ tracks: true });
    const ipc = await connect(h.sock);
    await ipc(["script-message", "sf-chapters-json", JSON.stringify(CHAPTERS)]);
    await ipc(["script-message", "sf-playback-json", playback({ title: EPISODE_TITLE, nextEpisode: null, previousEpisode: null })]);
    const layout = await waitLayout(h, ipc, "bar look", (l) =>
      Boolean(
        visible(l, "chapters") &&
          visible(l, "title")?.content === EPISODE_TITLE &&
          visible(l, "cy_sub")?.enabled &&
          visible(l, "cy_audio")?.enabled &&
          !visible(l, "cy_audio")?.off,
      ));
    const look = (e: LayoutElement) => ({ c1: e.c1, c3: e.c3, c4: e.c4, alpha: e.alpha, blur: e.blur, bord: e.bord, shad: e.shad });
    const fs = visible(layout, "tog_fs")!;
    const want = look(fs);
    const group = ["chapters", "cy_sub", "cy_audio", "cy_qual"];
    console.info(`${TAG} bar look: tog_fs=${JSON.stringify(want)} fs=${fs.fs} chip_r=${fs.chip_r}`);
    for (const name of [...group, "title"]) {
      const e = layout.elements[name]!;
      console.info(`${TAG} bar look: ${name}=${JSON.stringify(look(e))} fs=${e.fs} font=${e.font} chip_r=${e.chip_r} enabled=${e.enabled} off=${e.off}`);
    }
    expect(want.c1, "fullscreen: white like the phone's buttons").toBe("FFFFFF");
    for (const name of group) {
      const e = visible(layout, name)!;
      expect(e.enabled && !e.off, `${name} enabled (fixture has audio + subtitles)`).toBe(true);
      expect(look(e), `${name} drawn like fullscreen (colour, alpha, outline, shadow)`).toEqual(want);
      expect(e.chip_r, `${name} on a chip the size of fullscreen's`).toBe(fs.chip_r);
    }
    expect(visible(layout, "chapters")!.content ?? "", "Chapters is the drawn ≡ (an ASS vector)").toContain("\\p1");

    const title = visible(layout, "title")!;
    const outlineAlpha = title.alpha?.[2] ?? 255;
    expect(title.c3, "title outline colour is black").toBe("000000");
    expect(title.bord ?? 0, "title has an outline").toBeGreaterThanOrEqual(1);
    expect(outlineAlpha, "title outline is drawn (not fully clear)").toBeLessThan(255);
    expect((title.bord ?? 0) + 2 * (title.blur ?? 0), "title outline stays a thin glyph edge (cheap on the sw OSD)").toBeLessThanOrEqual(4);
  }, 90_000);

  it("first episode: no previous button; last episode: no next button", async () => {
    const h = await launch();
    const ipc = await connect(h.sock);
    await ipc(["script-message", "sf-playback-json", playback({
      title: "Lodgers · S1 E1",
      nextEpisode: { id: "ep-2", label: "S1E02" },
      previousEpisode: null,
    })]);
    const first = await waitLayout(h, ipc, "first episode", (l) => Boolean(visible(l, "ep_next")));
    expect(visible(first, "ep_prev"), "no previous on S1E1").toBeNull();
    expect(visible(first, "title")?.content, "name part omitted when the episode has none").toBe("Lodgers · S1 E1");

    await ipc(["script-message", "sf-playback-json", playback({
      title: "Lodgers · S1 E9",
      nextEpisode: null,
      previousEpisode: { id: "ep-8", label: "S1E08" },
    })]);
    const last = await waitLayout(h, ipc, "last episode", (l) => Boolean(visible(l, "ep_prev")));
    expect(visible(last, "ep_next"), "no next on the last uploaded episode").toBeNull();
  }, 90_000);

  for (const fullscreen of [true, false]) {
    const mode = fullscreen ? "fullscreen" : "windowed";
    it(`movie without chapters (${mode}): title and year shown, group starts at subtitles, no prev/next buttons`, async () => {
      const h = await launch({ fullscreen });
      const ipc = await connect(h.sock);
      await ipc(["script-message", "sf-chapters-json", "[]"]);
      await ipc(["script-message", "sf-playback-json", playback({ title: "Slow Burn (1995)", nextEpisode: null, previousEpisode: null })]);
      const layout = await waitLayout(h, ipc, `movie ${mode}`, (l) => visible(l, "title")?.content === "Slow Burn (1995)");
      expect(visible(layout, "chapters"), "no Chapters button without chapters").toBeNull();
      expectDesktopLayout(layout, `movie ${mode}`, false);
      for (const gone of ["ep_prev", "ep_next"]) {
        expect(visible(layout, gone), `${gone} must not be shown on a movie`).toBeNull();
      }
      expect(visible(layout, "playpause"), "play/pause stays").toBeTruthy();
    }, 90_000);
  }

  /**
   * MPV-OSC-02 (Chris 2026-10-29: "yes move the subs up then"): while the
   * controls show, the subtitle line sits above the bottom bar instead of under
   * the seekbar and buttons; when they hide it goes back to the user's own place
   * (sub-pos 97 here). Measured on window screenshots: the green line's pixels.
   */
  it("subtitles sit above the bottom bar while the controls show and go back when they hide", async () => {
    const h = await launch({ tracks: true });
    const ipc = await connect(h.sock);
    await ipc(["set_property", "sub-pos", 97]);
    await ipc(["script-message", "sf-chapters-json", JSON.stringify(CHAPTERS)]);
    await ipc(["script-message", "sf-playback-json", playback({
      title: EPISODE_TITLE,
      nextEpisode: { id: "ep-3", label: "S1E03" },
      previousEpisode: { id: "ep-1", label: "S1E01" },
    })]);
    const layout = await waitLayout(h, ipc, "subtitles shown", (l) =>
      Boolean(l.osc_visible && visible(l, "ep_next") && visible(l, "cy_sub")?.enabled));
    const bottomEls = Object.entries(layout.elements).filter(([, e]) => e.visible && e.y1 > layout.osd_h / 2);
    const barTop = Math.min(...bottomEls.map(([, e]) => e.y1));
    const barTopName = bottomEls.find(([, e]) => e.y1 === barTop)?.[0];
    let deadline = Date.now() + 3_000;
    let pos = (await ipc(["get_property", "sub-pos"])).data;
    while (Date.now() < deadline && pos === 97) {
      await sleep(100);
      pos = (await ipc(["get_property", "sub-pos"])).data;
    }
    await sleep(300);
    const shown = greenBox(await grab(h, ipc, "subtitles-controls-shown"));
    console.info(`${TAG} controls shown: sub-pos=${String(pos)} subtitle=${JSON.stringify(shown)} bar top=${barTop} (${barTopName}) osd=${layout.osd_w}x${layout.osd_h}\n${dumpLog(h, /sf-subs/)}`);
    expect(shown, "subtitle line visible with the controls shown (not drawn over by the bottom bar)").not.toBeNull();
    expect(shown!.y2, "subtitle line above the bottom bar while the controls show").toBeLessThan(barTop);

    // The path users hit: visibility auto, the pointer leaves the controls, the
    // hide timeout runs out and the fade ends in osc_visible(false).
    const autoHidden = await autoHide(h, ipc, "subtitles auto-hide");
    const autoPos = (await ipc(["get_property", "sub-pos"])).data;
    const autoShot = greenBox(await grab(h, ipc, "subtitles-controls-auto-hidden"));
    console.info(`${TAG} controls auto-hidden: osc_visible=${autoHidden.osc_visible} sub-pos=${String(autoPos)} subtitle=${JSON.stringify(autoShot)}\n${dumpLog(h, /sf-subs/)}`);
    expect(autoPos, "the user's own sub-pos comes back when the controls auto-hide").toBe(97);
    expect(autoShot, "subtitle line drawn after the auto-hide").not.toBeNull();
    expect(autoShot!.y2, "subtitle line back down at its own place after the auto-hide").toBeGreaterThan(shown!.y2);

    // Second check: switching the controls off entirely (the disabled-OSC branch of hide_osc).
    await ipc(["script-message", "osc-visibility", "always"]);
    const relifted = await waitSubPos(h, ipc, "lift again before osc-visibility never", (p) => p !== 97);
    expect(relifted, "subtitles lifted again before osc-visibility never").toBeLessThan(97);
    await ipc(["script-message", "osc-visibility", "never"]);
    await waitSubPos(h, ipc, "restore after osc-visibility never", (p) => p === 97);
    await sleep(300);
    const restored = (await ipc(["get_property", "sub-pos"])).data;
    const hidden = greenBox(await grab(h, ipc, "subtitles-controls-hidden"));
    console.info(`${TAG} controls hidden: sub-pos=${String(restored)} subtitle=${JSON.stringify(hidden)}\n${dumpLog(h, /sf-subs/)}`);
    expect(restored, "the user's own sub-pos comes back").toBe(97);
    expect(hidden, "subtitle line drawn").not.toBeNull();
    expect(hidden!.y2, "subtitle line back down at its own place").toBeGreaterThan(shown!.y2);
  }, 90_000);

  /**
   * MPV-OSC-02 (report, Chris 2026-10-30, testing PR 831 on a letterboxed
   * 2.39:1 film: the line jumped far above the bar when the controls showed):
   * the lift only clears the bottom bar. A line already above the bar
   * (drawn inside a letterboxed picture, above the lower black band) does not
   * move; a line under the bar moves just above it, not further. Subtitles that
   * libass keeps inside the picture (ASS, like PGS / VobSub) place sub-pos in the
   * picture's height, SRT in the window's, so both are measured.
   */
  const LIFT_CASES = [
    { name: "letterboxed 2.39:1 ASS line already above the bar", subFormat: "ass", videoSize: "192x80", window: "1164x860", fullscreen: false, moves: false },
    { name: "letterboxed 2.39:1 SRT line in the black band", subFormat: "srt", videoSize: "192x80", window: "1164x729", fullscreen: false, moves: true },
    { name: "16:9 ASS line under the bar", subFormat: "ass", videoSize: "64x36", window: undefined, fullscreen: true, moves: true },
    // picture subtitles (VobSub here; PGS and DVB take the same path): moved inside the picture
    { name: "letterboxed 2.39:1 VobSub picture already above the bar", subFormat: "vobsub", videoSize: "192x80", window: "1164x860", fullscreen: false, moves: false },
    { name: "letterboxed 2.39:1 VobSub picture under the bar", subFormat: "vobsub", videoSize: "192x80", window: "1164x729", fullscreen: false, moves: true },
  ] as const;
  for (const c of LIFT_CASES) {
    it(`the subtitle lift only clears the bottom bar: ${c.name}`, async () => {
      const h = await launch({ tracks: true, subFormat: c.subFormat, videoSize: c.videoSize, window: c.window, fullscreen: c.fullscreen });
      const ipc = await connect(h.sock);
      const layout = await waitLayout(h, ipc, `lift ${c.name}`, (l) => Boolean(l.osc_visible && visible(l, "seekbar") && visible(l, "cy_sub")?.enabled));
      const bottomEls = Object.entries(layout.elements).filter(([, e]) => e.visible && e.y1 > layout.osd_h / 2);
      const barTop = Math.min(...bottomEls.map(([, e]) => e.y1));
      await sleep(800);
      const shownPos = (await ipc(["get_property", "sub-pos"])).data;
      const dims = (await ipc(["get_property", "osd-dimensions"])).data;
      const sub = (await ipc(["get_property", "current-tracks/sub"])).data as { codec?: string; image?: boolean } | undefined;
      const shown = greenBox(await grab(h, ipc, `subtitles-lift-${c.subFormat}-${c.videoSize}-${c.window ?? "fs"}-shown`));
      await ipc(["script-message", "osc-visibility", "never"]);
      await waitSubPos(h, ipc, `lift ${c.name}: restore`, (p) => p === 100);
      await sleep(300);
      const hidden = greenBox(await grab(h, ipc, `subtitles-lift-${c.subFormat}-${c.videoSize}-${c.window ?? "fs"}-hidden`));
      const slack = Math.round(0.06 * layout.osd_h);
      console.info(`${TAG} lift ${c.name}: sub track codec=${sub?.codec} image=${String(sub?.image)} osd-dimensions=${JSON.stringify(dims)} bar top=${barTop} shown sub-pos=${String(shownPos)} line=${JSON.stringify(shown)} hidden line=${JSON.stringify(hidden)} slack=${slack}\n${dumpLog(h, /sf-subs/)}`);
      expect(shown, "subtitle line drawn with the controls shown").not.toBeNull();
      expect(hidden, "subtitle line drawn with the controls hidden").not.toBeNull();
      expect(shown!.y2, "subtitle line above the bottom bar while the controls show").toBeLessThan(barTop);
      if (c.moves) {
        expect(hidden!.y2, "fixture check: the hidden line reaches under the bar").toBeGreaterThanOrEqual(barTop);
        expect(barTop - shown!.y2, `lifted just above the bar (within ${slack}px), not further`).toBeLessThanOrEqual(slack);
      } else {
        expect(hidden!.y2, "fixture check: the hidden line already clears the bar").toBeLessThan(barTop);
        expect(Math.abs(shown!.y2 - hidden!.y2), "a line that already clears the bar does not move").toBeLessThanOrEqual(2);
      }
    }, 90_000);
  }

  /**
   * MPV-OSC-02: a sub-pos the user sets while the subtitles are lifted is their
   * new place. The lift is reapplied as min(lift, new place), and the new place
   * (not the one from before the controls showed) comes back when they hide.
   * 99 sits below the lift (the lift wins); 40 sits above it (the user's value wins).
   */
  for (const userPos of [99, 40]) {
    it(`a sub-pos the user sets while the subtitles are lifted (${userPos}) is kept and comes back on hide`, async () => {
      const h = await launch({ tracks: true });
      const ipc = await connect(h.sock);
      await ipc(["set_property", "sub-pos", 97]);
      await ipc(["script-message", "sf-playback-json", playback({ title: EPISODE_TITLE, nextEpisode: null, previousEpisode: null })]);
      await waitLayout(h, ipc, `user sub-pos ${userPos} shown`, (l) => Boolean(l.osc_visible && visible(l, "cy_sub")?.enabled));
      const lift = await waitSubPos(h, ipc, `user sub-pos ${userPos} first lift`, (p) => p !== 97);
      expect(lift, "the lift moved the subtitles up from 97").toBeLessThan(97);

      await ipc(["set_property", "sub-pos", userPos]);
      const expected = Math.min(lift, userPos);
      const applied = await waitSubPos(h, ipc, `user sub-pos ${userPos} reapplied (want ${expected})`, (p) => p === expected, 3_000);
      console.info(`${TAG} user sub-pos ${userPos}: lift=${lift} applied=${applied} expected=${expected}\n${dumpLog(h, /sf-subs/)}`);
      expect(applied, `lift reapplied as min(lift ${lift}, user ${userPos})`).toBe(expected);

      await autoHide(h, ipc, `user sub-pos ${userPos} auto-hide`);
      const restored = await waitSubPos(h, ipc, `user sub-pos ${userPos} restored`, (p) => p === userPos, 3_000);
      await grab(h, ipc, `subtitles-user-pos-${userPos}-hidden`);
      console.info(`${TAG} user sub-pos ${userPos}: restored=${restored}\n${dumpLog(h, /sf-subs/)}`);
      expect(restored, "the sub-pos the user set while lifted comes back on hide").toBe(userPos);
    }, 90_000);
  }

  /**
   * MPV-OSC-03 (Chris 2026-10-29: "keep the layout of the desktop player but
   * update the look and feel/theme of it to match the mobile player"): the
   * desktop controls stay where they are but are drawn like the phone player
   * (`packages/mobile-mpv-playback/src/components/PlayerControls.tsx`, its
   * DEFAULT_THEME read from the source here): Inter text, round translucent
   * button chips with white drawn icons, the CC / ♪ / HD / ≡ labels, a 6-high
   * (the phone's 8 dp at the desktop chrome's scale)
   * accent seekbar track (unplayed = accent at 30%) with a pill thumb, m:ss
   * timecodes, and the track menu as a dark #1f1f22 sheet. Checked on window
   * screenshot pixels against the phone theme's own colour values.
   */
  it("desktop controls look like the phone player: colours, font, icons, button chips, seekbar, track menu", async () => {
    const theme = mobileTheme();
    console.info(`${TAG} theme from PlayerControls.tsx: ${JSON.stringify(theme)}`);
    const h = await launch({ tracks: true });
    const ipc = await connect(h.sock);
    await ipc(["script-message", "sf-chapters-json", JSON.stringify(CHAPTERS)]);
    await ipc(["script-message", "sf-playback-json", playback({
      title: EPISODE_TITLE,
      nextEpisode: { id: "ep-3", label: "S1E03" },
      previousEpisode: { id: "ep-1", label: "S1E01" },
    })]);
    const ready = await waitLayout(h, ipc, "theme", (l) =>
      Boolean(
        l.osc_visible &&
          visible(l, "seekbar") &&
          visible(l, "ep_next") &&
          visible(l, "chapters") &&
          visible(l, "cy_sub")?.enabled &&
          visible(l, "title")?.content === EPISODE_TITLE,
      ));
    // Half way: the seekbar shows a played and an unplayed part.
    const seek = await ipc(["seek", 60, "absolute", "exact"]);
    const seekDeadline = Date.now() + 5_000;
    let at = (await ipc(["get_property", "time-pos"])).data;
    while (Date.now() < seekDeadline && !(typeof at === "number" && Math.abs(at - 60) < 0.5)) {
      await sleep(100);
      at = (await ipc(["get_property", "time-pos"])).data;
    }
    console.info(`${TAG} theme: seek 60 -> ${JSON.stringify(seek)} time-pos=${String(at)}`);
    // Let the OSC redraw at the new position before the layout and the screenshot.
    await sleep(500);
    const layout = (await readLayout(h, ipc)) ?? ready;
    const pos = (await ipc(["get_property", "time-pos"])).data;
    const els = layout.elements;
    for (const name of ["title", "tc_left", "tc_right", "playpause", "ep_prev", "ep_next", "chapters", "cy_sub", "cy_audio", "cy_qual", "tog_fs", "volume", "seekbar"]) {
      const e = els[name];
      console.info(`${TAG} theme element ${name}: box=${box(e ?? null)} font=${e?.font} fs=${e?.fs} c1=${e?.c1} c3=${e?.c3} alpha=${JSON.stringify(e?.alpha)} chip_r=${e?.chip_r} content=${JSON.stringify(e?.content)}`);
    }
    console.info(`${TAG} theme: time-pos=${String(pos)} osd=${layout.osd_w}x${layout.osd_h} virt_per_osd_y=${layout.virt_per_osd_y}`);

    // Font and labels (PlayerControls: Inter everywhere; CC / ♪ / HD / ≡; formatTime m:ss).
    expect.soft(els.title?.font, "title in Space Grotesk (MPV-OSC-04)").toBe("Space Grotesk");
    expect.soft(els.tc_left?.font, "timecodes in Inter").toBe("Inter");
    expect.soft(els.tc_left?.content, "current time as m:ss like the phone (formatTime)").toBe("1:00");
    expect.soft(els.tc_right?.content, "duration as m:ss like the phone (formatTime)").toBe("2:00");
    expect.soft(els.cy_sub?.content, "subtitles button draws an icon (ASS vector)").toContain("\\p1");
    // PLAY-OVL-05: lucide captions, a rounded box and 4 text lines (5 sub-paths), never an empty box or "CC".
    const subPaths = (els.cy_sub?.content ?? "").match(/(?:^|[ }])m /g)?.length ?? 0;
    console.info(`${TAG} cy_sub sub-paths=${subPaths}`);
    expect.soft(subPaths, "subtitles button is the captions icon: box + 4 text lines (PLAY-OVL-05)").toBe(5);
    expect.soft(els.cy_qual?.content, "quality button draws the settings icon").toContain("\\p1");
    expect.soft(els.cy_sub?.font, "CC in Inter").toBe("Inter");
    // ♪ and ≡ have no glyph in Inter: drawn as ASS vectors like the play / pause / skip icons.
    for (const name of ["cy_audio", "chapters"]) {
      expect.soft(els[name]?.content ?? "", `${name}: the drawn ${name === "cy_audio" ? "♪" : "≡"} (ASS vector)`).toContain("\\p1");
    }
    for (const name of ["playpause", "ep_prev", "ep_next"]) {
      expect.soft(els[name]?.content ?? "", `${name}: a drawn icon (ASS vector), like the phone's drawn play / pause / skip icons`).toContain("\\p1");
      expect.soft(els[name]?.c1, `${name}: white icon`).toBe("FFFFFF");
    }
    for (const name of ["playpause", "ep_prev", "ep_next", "chapters", "cy_sub", "cy_audio", "cy_qual", "tog_fs", "volume"]) {
      expect.soft(els[name]?.chip_r ?? 0, `${name}: sits on a round chip like the phone's buttons`).toBeGreaterThan(0);
    }

    const shot = await grab(h, ipc, "theme-controls");
    const sy = layout.virt_per_osd_y ?? 1;

    // Seekbar: played = accent, unplayed = accent at 30% over what is behind, a pill thumb at the play head.
    const bar = els.seekbar!;
    // Sample points come from the drawn geometry, so they stay inside the shapes at any OSC scale (MPV-OSC-05:
    // 2 OSD px per layout unit × hidpi, fullscreen included). The track is seekTrackH (5) of the element's
    // seekbarHeight (11) layout units, centred (tog4in1.lua layout()); its anti-aliased edge is ~1.5 px.
    const cyExact = (bar.y1 + bar.y2) / 2;
    const cy = Math.round(cyExact);
    const w = bar.x2 - bar.x1;
    const trackHalfPx = ((bar.y2 - bar.y1) * (5 / 11)) / 2;
    const trackOff = Math.max(1, Math.floor(trackHalfPx / 2)); // inside the track, off its centre line, clear of its edge
    const playedPx = px(shot, Math.round(bar.x1 + 0.25 * w), Math.round(cyExact + trackOff));
    const unplayedX = Math.round(bar.x1 + 0.8 * w);
    const unplayedPx = px(shot, unplayedX, Math.round(cyExact + trackOff));
    // what the unplayed track is drawn over: the backdrop at the same height, just past the bar's end
    const behindTrack = px(shot, Math.round(bar.x2 + 6 / sy), Math.round(cyExact + trackOff));
    // The pill thumb is a few px wide and sits at the play head (near half way, not exactly): find its column run on
    // a row above the track (red channel well above the backdrop's) and sample the run's centre, not its edge.
    const thumbY = Math.round(cy - 5 / sy);
    const approxX = Math.round(bar.x1 + 0.5 * w);
    const thumbXs: number[] = [];
    for (let x = approxX - Math.round(30 / sy); x <= approxX + Math.round(30 / sy); x++) {
      if (px(shot, x, thumbY)[0]! > 200) thumbXs.push(x);
    }
    const headX = thumbXs.length > 0 ? Math.round((thumbXs[0]! + thumbXs[thumbXs.length - 1]!) / 2) : approxX;
    const thumbPx = px(shot, headX, thumbY);
    const wantUnplayed = blend(theme.unplayed, behindTrack);
    console.info(
      `${TAG} seekbar geometry: bar=${bar.x1},${bar.y1}..${bar.x2},${bar.y2} sy=${sy} trackHalfPx=${trackHalfPx.toFixed(2)} trackOff=${trackOff} thumb run=${thumbXs[0]}..${thumbXs[thumbXs.length - 1]} @y=${thumbY}`,
    );
    console.info(`${TAG} seekbar pixels: played=${playedPx} want ${rgb(theme.accent)}; unplayed=${unplayedPx} want ${wantUnplayed} (behind ${behindTrack}); thumb@${headX}=${thumbPx} want ${rgb(theme.accent)}`);
    expect(thumbXs.length, `the pill thumb is drawn on row ${thumbY} near x=${approxX}`).toBeGreaterThan(0);
    // The play head is half way (time-pos at half the duration): the thumb's centre is there, to a few px.
    expect.soft(Math.abs(headX - approxX), `pill thumb centre x=${headX} vs half way x=${approxX}`).toBeLessThanOrEqual(3);
    expect.soft(near(playedPx, rgb(theme.accent), 12), `played part is the accent ${theme.accent.css}: got ${playedPx}`).toBe(true);
    expect.soft(near(unplayedPx, wantUnplayed, 14), `unplayed part is white at ${theme.unplayed.a}: got ${unplayedPx}, want ${wantUnplayed}`).toBe(true);
    expect.soft(near(thumbPx, rgb(theme.accent), 12), `pill thumb above the track at the play head is the accent: got ${thumbPx}`).toBe(true);

    // Buttons: a round chip in the centre chip colour (white icon on top), MPV-OSC-04.
    const play = els.playpause!;
    const next = els.ep_next!;
    const pcx = Math.round((play.x1 + play.x2) / 2);
    const pcy = Math.round((play.y1 + play.y2) / 2);
    const pr = play.chip_r ?? (play.y2 - play.y1) / 2;
    const nr = next.chip_r ?? (next.y2 - next.y1) / 2;
    const ncx = (next.x1 + next.x2) / 2;
    const sampleY = Math.round(pcy + 0.72 * pr);
    const chipPx = px(shot, pcx, sampleY);
    const gapX = Math.round((pcx + pr + (ncx - nr)) / 2);
    const besideChip = px(shot, gapX, sampleY);
    const wantChip = blend(theme.chromeBackground, besideChip);
    const iconPx = px(shot, Math.round(pcx - 0.1 * pr), pcy);
    console.info(`${TAG} play chip: r=${pr} centre=${pcx},${pcy} chip=${chipPx} want ${wantChip} (beside ${besideChip} @${gapX}); icon=${iconPx}`);
    expect.soft(near(chipPx, wantChip, 10), `play/pause chip is chromeBackground ${theme.chromeBackground.css}: got ${chipPx}, want ${wantChip}`).toBe(true);
    expect.soft(Math.min(...iconPx), `play icon is white: got ${iconPx}`).toBeGreaterThanOrEqual(235);

    // Track menu: the subtitle picker as the phone's dark sheet (#1f1f22), the focused row lifted like the TV's focused row.
    await click(ipc, visible(layout, "cy_sub")!);
    const opened = await waitPickerKeys(h, ipc);
    expect(opened, "subtitles button opens the track menu").toBe(true);
    await sleep(300);
    const menu = await grab(h, ipc, "theme-track-menu");
    const sheet = rgb(theme.sheetBackground);
    const focusRow = blend({ ...theme.text, a: 0.14 }, sheet);
    // Above the bottom chrome only: its dark backdrop gradient passes through these greys too.
    const menuArea = { ...menu, h: Math.max(0, Math.round(bar.y1 - 40 / sy)) };
    const sheetPixels = countNear(menuArea, sheet, 3);
    const focusPixels = countNear(menuArea, focusRow, 3);
    const osdFont = (await ipc(["get_property", "osd-font"])).data;
    console.info(`${TAG} track menu (rows 0..${menuArea.h}): sheet ${sheet} pixels=${sheetPixels} focused row ${focusRow} pixels=${focusPixels} osd-font=${String(osdFont)}`);
    expect.soft(sheetPixels, `track menu body is the phone sheet colour ${theme.sheetBackground.css}`).toBeGreaterThan(20_000);
    expect.soft(focusPixels, "focused row is lifted with white at 14% (TV focused row)").toBeGreaterThan(4_000);
    expect.soft(osdFont, "track menu text in Inter").toBe("Inter");
  }, 90_000);

  /**
   * MPV-OSC-03 (Chris 2026-10-30, after testing PR 831): "all icons should have
   * the same size", and the volume bar "more centered with the mute buttons ...
   * a little bit further to the right". Measured on the drawn pixels: the white
   * ink of each button inside its chip, and the accent track / thumb of the
   * volume bar against the mute chip.
   */
  it("bottom-bar icons share one glyph size; the volume bar is centred on the mute chip with a gap", async () => {
    const h = await launch({ tracks: true });
    const ipc = await connect(h.sock);
    await ipc(["script-message", "sf-chapters-json", JSON.stringify(CHAPTERS)]);
    await ipc(["script-message", "sf-playback-json", playback({
      title: EPISODE_TITLE,
      nextEpisode: { id: "ep-3", label: "S1E03" },
      previousEpisode: { id: "ep-1", label: "S1E01" },
    })]);
    // Unmuted so the volume bar shows its level; --ao=null keeps the run silent.
    await ipc(["set_property", "mute", "no"]);
    await ipc(["set_property", "volume", 50]);
    await waitLayout(h, ipc, "icon sizes", (l) =>
      Boolean(l.osc_visible && visible(l, "ep_next") && visible(l, "chapters") && visible(l, "cy_sub")?.enabled && visible(l, "volume_slider")));
    await sleep(500);
    const layout = (await readLayout(h, ipc))!;
    const shot = await grab(h, ipc, "icon-sizes");
    const sy = layout.virt_per_osd_y ?? 1;

    // White ink of a button: pixels brighter than the chip inside its circle.
    const ink = (name: string) => {
      const e = visible(layout, name)!;
      const cx = (e.x1 + e.x2) / 2, cy = (e.y1 + e.y2) / 2, r = (e.chip_r ?? (e.y2 - e.y1) / 2) * 0.92;
      let x1 = Infinity, y1 = Infinity, x2 = -1, y2 = -1, n = 0;
      for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
        for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
          if (Math.min(...px(shot, x, y)) >= 150) { n++; x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
        }
      }
      const w = x2 - x1 + 1, hh = y2 - y1 + 1;
      return { name, w, h: hh, size: Math.max(w, hh), ink: n, cx: (x1 + x2) / 2 - cx, cy: (y1 + y2) / 2 - cy, chip_r: e.chip_r };
    };
    const inks = Object.fromEntries(["chapters", "cy_sub", "cy_audio", "cy_qual", "tog_fs", "playpause", "ep_prev", "ep_next", "volume"].map((n) => [n, ink(n)]));
    for (const i of Object.values(inks)) console.info(`${TAG} ink ${JSON.stringify(i)}`);
    const fs = inks.tog_fs!;
    // One glyph box for the bottom row (MPV-OSC-04): the mockup draws its
    // lucide icons at one size, so chapters, subtitles, audio and quality
    // share fullscreen's box, centred in their chips like it.
    const ep = inks.ep_next!;
    for (const n of ["chapters", "cy_sub", "cy_audio", "cy_qual"]) {
      expect.soft(Math.abs(inks[n]!.size - fs.size), `${n}: glyph ${inks[n]!.w}x${inks[n]!.h} the size of the fullscreen glyph ${fs.w}x${fs.h}`).toBeLessThanOrEqual(3);
    }
    expect.soft(Math.abs(inks.ep_prev!.size - ep.size), `ep_prev glyph ${inks.ep_prev!.size} the size of ep_next's ${ep.size}`).toBeLessThanOrEqual(2);
    for (const n of ["chapters", "cy_sub", "cy_audio", "cy_qual"]) {
      expect.soft(Math.abs(inks[n]!.cy - fs.cy), `${n}: glyph centred in its chip like fullscreen (dy ${inks[n]!.cy} vs ${fs.cy})`).toBeLessThanOrEqual(1.5);
    }
    // Play keeps the phone's 26 : 20 against the episode glyphs.
    expect.soft(inks.playpause!.size / ep.size, `play glyph ${inks.playpause!.size} to episode glyph ${ep.size}, the phone's 26 : 20`).toBeGreaterThanOrEqual(1.2);
    expect.soft(inks.playpause!.size / ep.size, `play glyph ${inks.playpause!.size} to episode glyph ${ep.size}, the phone's 26 : 20`).toBeLessThanOrEqual(1.45);

    // Volume bar: track and thumb centred on the mute chip's centre, a gap after the chip.
    const mute = visible(layout, "volume")!;
    const slider = visible(layout, "volume_slider")!;
    const mcx = (mute.x1 + mute.x2) / 2, mr = mute.chip_r ?? (mute.y2 - mute.y1) / 2;
    // The chip as drawn: rows of its centre column that differ from the bare backdrop beside it.
    const backdropX = Math.max(0, Math.round(mcx - 1.6 * mr));
    const chipRows: number[] = [];
    for (let y = Math.floor((mute.y1 + mute.y2) / 2 - 1.3 * mr); y <= Math.ceil((mute.y1 + mute.y2) / 2 + 1.3 * mr); y++) {
      const a = px(shot, Math.round(mcx), y), b = px(shot, backdropX, y);
      if (a.some((v, i) => Math.abs(v - b[i]!) > 5)) chipRows.push(y);
    }
    const mcy = (chipRows[0]! + chipRows.at(-1)!) / 2;
    const accentish = (x: number, y: number) => { const [r, g, b] = px(shot, x, y); return r > 90 && r - b > 40 && r >= g; };
    const column = (x: number) => {
      let top = -1, bottom = -1;
      for (let y = Math.floor(mcy - mr); y <= Math.ceil(mcy + mr); y++) if (accentish(x, y)) { if (top < 0) top = y; bottom = y; }
      return top < 0 ? null : { x, top, bottom, h: bottom - top + 1, cy: (top + bottom) / 2 };
    };
    const cols = [];
    for (let x = Math.floor(mcx + mr); x <= Math.ceil(slider.x2 + 10); x++) { const c = column(x); if (c) cols.push(c); }
    expect(cols.length, "volume bar drawn").toBeGreaterThan(10);
    const trackStart = cols[0]!.x;
    const thumb = cols.reduce((a, c) => (c.h > a.h ? c : a));
    const track = cols[Math.min(cols.length - 1, 6)]!;
    const gap = trackStart - (mcx + mr);
    console.info(`${TAG} volume: mute chip centre=${mcx},${mcy} (drawn rows ${chipRows[0]}..${chipRows.at(-1)}) r=${mr}; track start x=${trackStart} gap=${gap.toFixed(1)}px (${(gap * sy).toFixed(1)} virt); track col=${JSON.stringify(track)} thumb col=${JSON.stringify(thumb)} slider box=${box(slider)}`);
    expect.soft(Math.abs(track.cy - mcy), `volume track centred on the mute chip (track cy ${track.cy}, chip cy ${mcy})`).toBeLessThanOrEqual(1);
    expect.soft(Math.abs(thumb.cy - mcy), `volume thumb centred on the mute chip (thumb cy ${thumb.cy}, chip cy ${mcy})`).toBeLessThanOrEqual(1);
    expect.soft(gap * sy, "gap between the mute chip and the volume track (virtual px)").toBeGreaterThanOrEqual(8);

    // Seekbar chapter tick (40 s of 120 s): the 2-unit nibble hangs from the track's
    // bottom edge, one slider gap (3 virtual px) long, and moves down with the track.
    // The tick is the opaque accent; the unplayed track around it white at 0.25 (MPV-OSC-04),
    // so brighter than the backdrop just above the bar.
    const seek = visible(layout, "seekbar")!;
    const opaque = (x: number, y: number) => { const [r, , b] = px(shot, x, y); return r > 200 && r - b > 80; };
    const above = (x: number) => px(shot, x, Math.floor(seek.y1 - 20));
    const faded = (x: number, y: number) => { const c = px(shot, x, y), b = above(x); return c[0] + c[1] + c[2] - (b[0] + b[1] + b[2]) > 30 && !opaque(x, y); };
    const rows = (x: number, hit: (x: number, y: number) => boolean) => {
      let top = -1, bottom = -1;
      for (let y = Math.floor(seek.y1 - 20); y <= Math.ceil(seek.y2 + 20); y++) if (hit(x, y)) { if (top < 0) top = y; bottom = y; }
      return top < 0 ? null : { top, bottom };
    };
    const tickXs: number[] = [];
    for (let x = Math.round(seek.x1 + 0.2 * (seek.x2 - seek.x1)); x <= Math.round(seek.x1 + 0.5 * (seek.x2 - seek.x1)); x++) if (rows(x, opaque)) tickXs.push(x);
    expect(tickXs.length, "chapter tick drawn on the seekbar").toBeGreaterThan(0);
    const tickX = tickXs[Math.floor(tickXs.length / 2)]!;
    const tick = rows(tickX, opaque)!;
    const trackRows = rows(tickX - 20, faded)!;
    const wantLen = 3 / sy; // MPV-OSC-04: (11 - 5) / 2
    console.info(`${TAG} chapter tick x=${tickX} (cols ${tickXs[0]}..${tickXs.at(-1)}) rows ${tick.top}..${tick.bottom}; track rows ${trackRows.top}..${trackRows.bottom}; want ${wantLen.toFixed(1)}px below the track`);
    expect.soft(tick.top - (trackRows.bottom + 1), `chapter tick starts at the track's bottom edge (tick top ${tick.top}, track bottom ${trackRows.bottom})`).toBeGreaterThanOrEqual(-1.5);
    expect.soft(tick.top - (trackRows.bottom + 1), `chapter tick starts at the track's bottom edge (tick top ${tick.top}, track bottom ${trackRows.bottom})`).toBeLessThanOrEqual(1.5);
    expect.soft(Math.abs(tick.bottom - trackRows.bottom - wantLen), `chapter tick reaches one slider gap below the track (${tick.bottom - trackRows.bottom}px, want ${wantLen.toFixed(1)})`).toBeLessThanOrEqual(2);
  }, 90_000);

  /**
   * MPV-OSC-03: with no play position (before the file loads, or a stream
   * without a duration) the phone shows its whole track unplayed; the desktop
   * seek track does the same instead of leaving the bar blank.
   */
  it("no play position: the seekbar shows the whole track unplayed, like the phone", async () => {
    const theme = mobileTheme();
    // Next file is a pipe nobody writes to: the window stays up while mpv waits to open it
    // (before file-loaded), so there is no percent-pos.
    const fifoDir = mkdtempSync(join(tmpdir(), "sf-osc-nopos-"));
    const fifo = join(fifoDir, "never-written.ts");
    expect(spawnSync("mkfifo", [fifo]).status, "mkfifo").toBe(0);
    const h = await launch();
    const ipc = await connect(h.sock);
    await waitLayout(h, ipc, "fixture", (l) => Boolean(l.osc_visible && visible(l, "seekbar")));
    await ipc(["loadfile", fifo, "replace"]);
    const layout = await waitLayout(h, ipc, "no-position", (l) => Boolean(l.osc_visible && visible(l, "seekbar")));
    const percent = await ipc(["get_property", "percent-pos"]);
    console.info(`${TAG} no-position: percent-pos=${JSON.stringify(percent)}`);
    expect(percent.data ?? null, "no play position before the file loads").toBeNull();
    const shot = await grab(h, ipc, "theme-seekbar-no-position");
    const sy = layout.virt_per_osd_y ?? 1;
    const bar = layout.elements.seekbar!;
    const cy = Math.round((bar.y1 + bar.y2) / 2) + Math.max(1, Math.round(1.5 / sy));
    const behind = px(shot, Math.round(bar.x2 + 6 / sy), cy);
    const want = blend(theme.unplayed, behind);
    for (const f of [0.1, 0.5, 0.9]) {
      const got = px(shot, Math.round(bar.x1 + f * (bar.x2 - bar.x1)), cy);
      console.info(`${TAG} no-position seekbar @${f}: ${got} want ${want} (behind ${behind})`);
      expect.soft(near(got, want, 14), `seek track at ${f} is the unplayed white: got ${got}, want ${want}`).toBe(true);
    }
    rmSync(fifoDir, { recursive: true, force: true });
  }, 60_000);
});

/**
 * MPV-OSC-03: the desktop controls draw text in the phone app's own Inter file,
 * a copy shipped with the mpv scripts (mpv loads fonts from --osd-fonts-dir).
 * The two copies must not drift apart.
 */
describe("desktop player font matches the phone app", () => {
  it("tog4in1/fonts/Inter.ttf is the phone app's Inter.ttf", () => {
    const desktop = fileURLToPath(new URL("../resources/osc/tog4in1/fonts/Inter.ttf", import.meta.url));
    const phone = fileURLToPath(new URL("../../../apps/badger/mobile/src/assets/fonts/Inter.ttf", import.meta.url));
    const sha = (f: string) => (existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : `missing ${f}`);
    console.info(`${TAG} Inter: desktop=${sha(desktop)} phone=${sha(phone)}`);
    expect(sha(desktop)).toBe(sha(phone));
  });
});
