/**
 * @bugfix mpv-unused-builtin-scripts-loaded (#25 size/perf §2.4, P13)
 * @regression-proof
 *
 * mpv 0.41 loads eight built-in Lua scripts unless told not to: ytdl_hook,
 * stats, console, select, positioning, commands, auto_profiles, context_menu.
 * Each is a Lua state plus a thread, set up on every launch. The product uses
 * one of them: `console`, which backs `mp.input` (sf-select.lua's track menus).
 * `--no-ytdl` already drops ytdl_hook; this guards that the other unused ones
 * stay off and that the track menu still opens.
 *
 * Launches the REAL bundled mpv with the REAL product arguments
 * (`buildExternalMpvArgs`), `--vo=null`, and reads mpv's own
 * "Loading lua script @<name>.lua" log lines. Pre-fix the list is
 * auto_profiles, commands, console, context_menu, positioning, select, stats.
 *
 * Skips (loudly) without a runnable mpv.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireMediaBinary } from "@space/media-deps";
import { buildExternalMpvArgs, resolveExternalMpvTarget } from "../src/external";
import { resolveMpvOscScript, resolveMpvTog4in1FontsDir } from "../src/index";

const TAG = "[mpv-builtin-scripts]";
/** The only mpv built-in script the product needs (mp.input → console). */
const EXPECTED_BUILTINS = ["console"];

const target = process.platform === "linux" ? resolveExternalMpvTarget() : null;
const oscScript = resolveMpvOscScript();
const ffmpeg = spawnSync("sh", ["-c", "command -v ffmpeg"]).status === 0;
requireMediaBinary("mpv (shipped bundle) + sf.lua", Boolean(target && target.kind !== "fallback" && oscScript));
requireMediaBinary("ffmpeg", ffmpeg);
const runnable = Boolean(target && target.kind !== "fallback" && oscScript && ffmpeg);
if (!runnable) {
  console.warn(
    `${TAG} SKIP: platform=${process.platform} mpv=${target?.kind ?? "n/a"} osc=${oscScript ?? "none"} ffmpeg=${ffmpeg}. Run \`bun run setup:binaries\` and install ffmpeg.`,
  );
}

// Real-clock waits are deliberate: this drives a separate mpv process whose
// clock fake timers cannot control. Every wait is a bounded poll.
const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

type Reply = { request_id?: number; data?: unknown; error?: string };
type Harness = { dir: string; mpv: ChildProcess; logFile: string; sock: string };
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

/** 16-bit PCM WAV of silence. */
const silentWav = (rate: number, channels: number, seconds: number): Buffer => {
  const data = rate * channels * 2 * seconds;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data, 40);
  return Buffer.concat([header, Buffer.alloc(data)]);
};

const launch = async (): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), "sf-mpv-builtins-"));
  const sock = join(dir, "mpv.sock");
  const logFile = join(dir, "mpv.log");
  // Two audio tracks so the audio menu has something to list. CI's shipped
  // ffmpeg (media-deps bundle) has no `sine`/`anullsrc` source, no raw `s16le`
  // demuxer and no pcm encoder, but has the wav demuxer and aac: write a
  // silent WAV here and encode it.
  const wav = join(dir, "silence.wav");
  writeFileSync(wav, silentWav(48_000, 2, 30));
  const fixture = join(dir, "fixture.mkv");
  const enc = spawnSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=gray:s=64x36:r=4:d=30",
    "-i", wav,
    "-map", "0", "-map", "1", "-map", "1",
    "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", fixture,
  ]);
  if (enc.status !== 0) throw new Error(`${TAG} fixture encode failed: ${enc.stderr?.toString()}`);
  const args = buildExternalMpvArgs({
    url: fixture,
    vo: "null",
    hwdec: "no",
    logFile,
    paused: true,
    extraArgs: ["--ao=null", "--no-terminal", `--input-ipc-server=${sock}`],
  });
  // Hermetic fonts: console.lua sizes its menu by measuring text in the
  // default `sans-serif` through fontconfig. A host with no system fonts (the
  // CI container) measures nothing, and console.lua crashes in get-input
  // (`console.lua:345: attempt to perform arithmetic on field 'x1'`), so the
  // menu never opens whatever scripts are loaded. Pointing fontconfig at a
  // copy of the bundled OSC fonts only gives every host the same font set
  // (a copy: fontconfig writes a `.uuid` into each font dir it scans); real
  // user hosts always have system fonts.
  const bundledFonts = resolveMpvTog4in1FontsDir();
  if (!bundledFonts) throw new Error(`${TAG} bundled OSC fonts dir not found`);
  const fontsDir = join(dir, "fonts");
  cpSync(bundledFonts, fontsDir, { recursive: true });
  const fontsConf = join(dir, "fonts.conf");
  writeFileSync(
    fontsConf,
    `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><dir>${fontsDir}</dir><cachedir>${join(dir, "fc-cache")}</cachedir></fontconfig>\n`,
  );
  console.info(`${TAG} fontconfig ${fontsConf} -> ${fontsDir} (copy of ${bundledFonts})`);
  const env = {
    ...process.env,
    FONTCONFIG_FILE: fontsConf,
    ...(target!.kind === "bundle" && target!.libDirs.length > 0
      ? { LD_LIBRARY_PATH: [target!.libDirs.join(":"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
      : {}),
  };
  console.info(`${TAG} launch bin=${target!.bin} kind=${target!.kind}`);
  console.info(`${TAG} args ${args.join(" ")}`);
  console.info(`${TAG} mpv log file: ${logFile}`);
  const mpv = spawn(target!.bin, args, { stdio: "ignore", detached: true, env });
  mpv.unref();
  const h: Harness = { dir, mpv, logFile, sock };
  live.push(h);
  const deadline = Date.now() + 20_000;
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

describe.skipIf(!runnable)("mpv built-in scripts on a product launch (real mpv)", () => {
  // @req MPV-OSC-01 — no control script other than ours (plus mp.input's console) runs.
  it("loads only the console built-in, and the track menu (mp.input) still opens", async () => {
    const h = await launch();
    const ipc = await connect(h.sock);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (typeof (await ipc(["get_property", "duration"])).data === "number") break;
      await sleep(100);
    }
    const builtins = [...readFileSync(h.logFile, "utf8").matchAll(/Loading lua script @([\w-]+)\.lua/g)].map((m) => m[1]!).sort();
    const ours = [...readFileSync(h.logFile, "utf8").matchAll(/Loading lua script (\/[^@\n]+\.lua)/g)].map((m) => m[1]!);
    console.info(`${TAG} built-in scripts loaded: ${builtins.join(", ") || "(none)"}`);
    console.info(`${TAG} product scripts loaded: ${ours.join(", ")}`);

    // Consumer path that needs console: the OSC's audio button runs this binding.
    await ipc(["script-binding", "sf_select/select-aid"]);
    let open: unknown = false;
    const openDeadline = Date.now() + 5_000;
    while (Date.now() < openDeadline && open !== true) {
      open = (await ipc(["get_property", "user-data/mpv/console/open"])).data;
      if (open !== true) await sleep(50);
    }
    console.info(`${TAG} console open after select-aid: ${String(open)}`);
    if (open !== true || builtins.join() !== EXPECTED_BUILTINS.join()) {
      console.error(`${TAG} FAIL dump\n${dumpLog(h, /Loading lua script|console|sf_select|error/i)}`);
    }
    expect(builtins, "only the console built-in may load").toEqual(EXPECTED_BUILTINS);
    expect(ours.some((p) => p.endsWith("sf.lua")), "sf.lua must still load").toBe(true);
    expect(open, "the track menu must open (mp.input via console)").toBe(true);
  }, 60_000);
});
