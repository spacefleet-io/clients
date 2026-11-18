import { execFile, spawn } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { findForeignDlls, findUnreachableLibraries, readElfNeeded } from "./bundleClosure";
import {
  COMPONENT_LIST_ARGS,
  LISTED_COMPONENT_KINDS,
  findMissingComponents,
  isUnlistedDemuxer,
  parseComponentListing,
  type ListedComponentKind,
} from "./components";
import { FFMPEG_COMPONENTS, MPV_FEATURES, REQUIRED_SOFTWARE_ENCODERS, ffmpegComponentFlags } from "./features";
import { findBundledHostLibraries } from "./hostLibraries";
import { missingEntries, parseFfmpegHwaccels, parseMpvHwdecHelp, parseMpvObjectHelp } from "./listings";
import { hardwareFlags } from "./plan";
import type { DepsTarget, DesktopDepsTarget } from "./target";
import { verifyMobileTarget } from "./verifyMobile";

const execFileAsync = promisify(execFile);

/** LSMinimumSystemVersion / LC_BUILD_VERSION minos of every macOS bundle (MACOSX_DEPLOYMENT_TARGET). */
const MACOS_MINIMUM = "14.0";

export type VerifyOptions = {
  /** The bundle root: `bin/` (ffmpeg, ffprobe, …) plus whatever the target's `layout` puts beside it. */
  bundleDir: string;
  target: DepsTarget;
  /** `process.platform` of this machine: the bundle is RUN, so it must be the target's OS. */
  hostPlatform: string;
  /** The product OSC (`packages/mpv/resources/osc/sf.lua`); skipped when absent. */
  oscScript?: string;
  log?: (line: string) => void;
};

export type VerifyResult = { ok: boolean; failures: string[]; passed: string[] };

type Run = { stdout: string; stderr: string; code: number };

const run = async (file: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<Run> => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: options.cwd,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number | string; message: string };
    return {
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? failed.message,
      code: typeof failed.code === "number" ? failed.code : 1,
    };
  }
};

/** Sends one mpv JSON IPC command and resolves the reply with the matching request id. */
const mpvIpcRequest = (endpoint: string, command: unknown[], timeoutMs: number): Promise<Record<string, unknown>> => {
  const { promise, resolve, reject } = Promise.withResolvers<Record<string, unknown>>();
  const socket = net.connect(endpoint);
  let buffer = "";
  const timer = setTimeout(() => {
    socket.destroy();
    reject(new Error("mpv_ipc_timeout"));
  }, timeoutMs);
  socket.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  socket.once("connect", () => socket.write(`${JSON.stringify({ command, request_id: 7 })}\n`));
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (const line of buffer.split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const message = JSON.parse(line) as Record<string, unknown>;
        if (message.request_id === 7) {
          clearTimeout(timer);
          socket.destroy();
          resolve(message);
          return;
        }
      } catch {
        // A partial line: wait for the rest.
      }
    }
  });
  return promise;
};
const SAMPLE_WIDTH = 640;
const SAMPLE_HEIGHT = 360;
const SAMPLE_FPS = 24;
const SAMPLE_SECONDS = 2;
const SAMPLE_RATE = 48_000;

/** A moving gradient clip (raw yuv420p) and a 440 Hz mono WAV: inputs that need no test-source filters. */
const writeSampleInputs = (dir: string): { yuv: string; wav: string } => {
  const frameBytes = (SAMPLE_WIDTH * SAMPLE_HEIGHT * 3) / 2;
  const video = Buffer.alloc(frameBytes * SAMPLE_FPS * SAMPLE_SECONDS);
  for (let frame = 0; frame < SAMPLE_FPS * SAMPLE_SECONDS; frame++) {
    const base = frame * frameBytes;
    for (let y = 0; y < SAMPLE_HEIGHT; y++) {
      for (let x = 0; x < SAMPLE_WIDTH; x++) video[base + y * SAMPLE_WIDTH + x] = (x + y + frame * 4) & 0xff;
    }
    video.fill(128 + (frame & 31), base + SAMPLE_WIDTH * SAMPLE_HEIGHT, base + frameBytes);
  }
  const samples = SAMPLE_RATE * SAMPLE_SECONDS;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 12_000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  const yuv = path.join(dir, "sample.yuv");
  const wav = path.join(dir, "sample.wav");
  writeFileSync(yuv, video);
  writeFileSync(wav, Buffer.concat([header, pcm]));
  return { yuv, wav };
};

/** Where mpv and the shared libraries sit in a target's bundle (`DepsTarget.layout`, default a flat bin/). */
export const targetLayout = (target: DesktopDepsTarget): { mpv: string; libDir: string } =>
  target.layout ?? { mpv: `bin/mpv${target.exeSuffix}`, libDir: "bin" };

const MACHO_MAGICS = new Set([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

const isMachO = (file: string): boolean => {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(4);
    return readSync(fd, head, 0, 4, 0) === 4 && MACHO_MAGICS.has(head.readUInt32BE(0));
  } finally {
    closeSync(fd);
  }
};

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });

/**
 * The macOS bundle contract (REL-DEPS-09 / the platform layer's layout): every Mach-O is the target's single
 * architecture with minos 14.0, links nothing but `@rpath/` libraries shipped in lib/ and the OS (/usr/lib,
 * /System), carries exactly the layout's LC_RPATHs and a valid (ad-hoc) signature; the bundle has no symlinks.
 */
const macBundleProblems = async (bundleDir: string, target: DesktopDepsTarget): Promise<string[]> => {
  const problems: string[] = [];
  const layout = targetLayout(target);
  const libDir = path.join(bundleDir, layout.libDir);
  const shipped = new Set(readdirSync(libDir));
  const arch = target.arch === "arm64" ? "arm64" : "x86_64";
  const mpv = path.join(bundleDir, layout.mpv);
  // mpv sits in <app>/Contents/MacOS: one rpath to the bundle's lib/ (dev checkout), one to Resources/deps/lib (packaged app).
  const mpvToBundle = path.relative(path.dirname(mpv), bundleDir).split(path.sep).join("/");
  for (const file of walk(bundleDir)) {
    const name = path.relative(bundleDir, file);
    if (lstatSync(file).isSymbolicLink()) {
      problems.push(`symlink:${name}`);
      continue;
    }
    if (!isMachO(file)) continue;
    const archs = (await run("lipo", ["-archs", file])).stdout.trim();
    if (archs !== arch) problems.push(`arch:${name}:${archs} (want ${arch})`);
    const loadCommands = (await run("otool", ["-l", file])).stdout;
    const minos = /cmd LC_BUILD_VERSION\n(?:.*\n)*?\s+minos (\S+)/.exec(loadCommands)?.[1];
    if (minos !== MACOS_MINIMUM) problems.push(`minos:${name}:${minos ?? "none"} (want ${MACOS_MINIMUM})`);
    // LC_RPATH paths, in load-command order.
    const rpaths = [...loadCommands.matchAll(/cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (.+) \(offset \d+\)/g)].map((match) => match[1] ?? "");
    const wantRpaths =
      file === mpv
        ? [`@executable_path/${mpvToBundle}/${layout.libDir}`, `@executable_path/${mpvToBundle}/../Resources/deps/${layout.libDir}`]
        : path.dirname(file) === libDir
          ? ["@loader_path"]
          : [`@loader_path/${path.relative(path.dirname(file), libDir).split(path.sep).join("/")}`];
    if (rpaths.join("|") !== wantRpaths.join("|")) problems.push(`rpaths:${name}:${rpaths.join(",") || "none"} (want ${wantRpaths.join(",")})`);
    const ownId = (await run("otool", ["-D", file])).stdout.split("\n")[1]?.trim();
    if (path.dirname(file) === libDir && ownId !== `@rpath/${path.basename(file)}`) problems.push(`install_name:${name}:${ownId}`);
    const links = (await run("otool", ["-L", file])).stdout
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(" (")[0] ?? "")
      .filter((dep) => dep && dep !== ownId);
    for (const dep of links) {
      if (dep.startsWith("/usr/lib/") || dep.startsWith("/System/")) continue;
      if (dep.startsWith("@rpath/") && shipped.has(dep.slice("@rpath/".length))) continue;
      problems.push(`link:${name}:${dep}`);
    }
    const signature = await run("codesign", ["--verify", "--strict", file]);
    if (signature.code !== 0) problems.push(`codesign:${name}:${signature.stderr.trim()}`);
  }
  const app = layout.mpv.split("/").find((part) => part.endsWith(".app"));
  if (app) {
    const appSignature = await run("codesign", ["--verify", "--strict", path.join(bundleDir, app)]);
    if (appSignature.code !== 0) problems.push(`codesign:${app}:${appSignature.stderr.trim()}`);
    const plist = path.join(bundleDir, app, "Contents", "Info.plist");
    const key = async (name: string) => (await run("plutil", ["-extract", name, "raw", "-o", "-", plist])).stdout.trim();
    if ((await key("CFBundleExecutable")) !== path.basename(mpv)) problems.push(`info_plist:CFBundleExecutable:${await key("CFBundleExecutable")}`);
    if ((await key("LSMinimumSystemVersion")) !== MACOS_MINIMUM) problems.push(`info_plist:LSMinimumSystemVersion:${await key("LSMinimumSystemVersion")}`);
    if (!(await key("CFBundleIdentifier"))) problems.push("info_plist:CFBundleIdentifier_missing");
    // The Dock, Cmd+Tab and Spotlight show these names: they are the helper's folder name ("Badger Player", REL-MAC-09).
    for (const name of ["CFBundleName", "CFBundleDisplayName"]) {
      const value = await key(name);
      if (value !== path.basename(app, ".app")) problems.push(`info_plist:${name}:${value} (want ${path.basename(app, ".app")})`);
    }
  }
  return problems;
};

/**
 * Checks one built bundle by RUNNING it, so it must execute on the target OS (the Linux host for
 * linux-x64, the Windows VM for windows-x64, a Mac for both macOS targets: x64 under Rosetta 2).
 * Mobile bundles cannot run on the build host: they are verified statically (`verifyMobileTarget`).
 * Collects every failure instead of stopping at the first.
 */
export const verifyTarget = async (options: VerifyOptions): Promise<VerifyResult> => {
  if (options.target.kind === "mobile") return verifyMobileTarget({ ...options, target: options.target });
  const target = options.target;
  const { bundleDir } = options;
  const log = options.log ?? ((line: string) => console.info(line));
  if (options.hostPlatform !== target.nodePlatform) {
    throw new Error(`verify_needs_${target.os}_host:running_on_${options.hostPlatform}`);
  }

  const failures: string[] = [];
  const passed: string[] = [];
  const check = async (name: string, body: () => Promise<string | void>) => {
    try {
      const detail = await body();
      passed.push(name);
      log(`[media-deps:verify] ok   ${name}${detail ? ` (${detail})` : ""}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
      log(`[media-deps:verify] FAIL ${name}: ${message}`);
    }
  };

  const layout = targetLayout(target);
  const exe = (name: string) => path.join(bundleDir, "bin", `${name}${target.exeSuffix}`);
  const [ffmpeg, ffprobe, mpv] = [exe("ffmpeg"), exe("ffprobe"), path.join(bundleDir, layout.mpv)];
  const binDir = path.join(bundleDir, "bin");
  const libDir = path.join(bundleDir, layout.libDir);
  const work = mkdtempSync(path.join(os.tmpdir(), "sf-media-deps-verify-"));
  // The libraries must resolve from the bundle alone, never from the host environment.
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH;
  delete env.DYLD_LIBRARY_PATH;
  delete env.DYLD_FALLBACK_LIBRARY_PATH;

  try {
    await check("binaries present", async () => {
      for (const file of [ffmpeg, ffprobe, mpv]) if (!existsSync(file)) throw new Error(`missing:${file}`);
    });
    if (failures.length > 0) return { ok: false, failures, passed };

    await check("ffmpeg/ffprobe are 8.x", async () => {
      for (const file of [ffmpeg, ffprobe]) {
        const out = await run(file, ["-hide_banner", "-version"]);
        if (!/version n?8\./.test(out.stdout)) throw new Error(`${path.basename(file)}:${out.stdout.split("\n")[0] || out.stderr}`);
      }
    });

    const listings: Partial<Record<ListedComponentKind, string>> = {};
    await check("ffmpeg listings", async () => {
      for (const kind of LISTED_COMPONENT_KINDS) {
        const out = await run(ffmpeg, ["-hide_banner", COMPONENT_LIST_ARGS[kind]]);
        if (out.code !== 0) throw new Error(`${COMPONENT_LIST_ARGS[kind]}:${out.stderr}`);
        listings[kind] = out.stdout;
      }
    });
    await check("every kept component is built", async () => {
      const missing = findMissingComponents([...ffmpegComponentFlags(), ...hardwareFlags(target)], listings);
      if (missing.length > 0) throw new Error(`components_not_built:${missing.join(",")}`);
    });
    await check("image pipe demuxers are in libavformat", async () => {
      // `-demuxers` hides them, so the registered name must appear in the library itself.
      const library = readdirSync(libDir).find((name) => /^(libavformat\.so|avformat-\d+\.dll$|libavformat\.\d+\.dylib$)/.test(name));
      if (!library) throw new Error("libavformat_not_found");
      const text = readFileSync(path.join(libDir, library)).toString("latin1");
      const missing = FFMPEG_COMPONENTS.demuxer.filter((name) => isUnlistedDemuxer(name) && !text.includes(name));
      if (missing.length > 0) throw new Error(`image_pipe_demuxers_missing:${missing.join(",")}`);
    });
    await check("software and hardware encoders listed", async () => {
      const encoders = parseComponentListing("encoder", listings.encoder ?? "");
      const wanted = [
        ...REQUIRED_SOFTWARE_ENCODERS,
        ...target.hardwareEncoders.flatMap((family) => [`h264_${family}`, `hevc_${family}`]),
      ];
      const missing = wanted.filter((name) => !encoders.has(name.replaceAll("_", "")));
      if (missing.length > 0) throw new Error(`encoders_missing:${missing.join(",")}`);
    });

    // The build keeps no test-source filters, so the inputs are written here: a raw yuv420p clip
    // (rawvideo demuxer) and a mono 48 kHz 440 Hz WAV (wav demuxer + pcm_s16le).
    const { yuv, wav } = writeSampleInputs(work);
    const videoIn = ["-f", "rawvideo", "-pix_fmt", "yuv420p", "-video_size", `${SAMPLE_WIDTH}x${SAMPLE_HEIGHT}`, "-framerate", `${SAMPLE_FPS}`, "-i", yuv];

    // Real transcodes: the product's CPU recipes, 360p, through the libx264/libx265/aac/mp4 paths.
    await check("360p libx264 + aac transcode", async () => {
      const mp4 = path.join(work, "sample.mp4");
      const out = await run(ffmpeg, [
        "-hide_banner", "-v", "error", "-y",
        ...videoIn, "-i", wav,
        "-vf", `scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT},format=yuv420p`,
        "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", "-shortest", mp4,
      ]);
      if (out.code !== 0) throw new Error(out.stderr);
      const probe = await run(ffprobe, ["-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "csv=p=0", mp4]);
      const lines = probe.stdout.trim().split(/\r?\n/).sort();
      if (!(lines.includes(`h264,${SAMPLE_WIDTH},${SAMPLE_HEIGHT}`) && lines.includes("aac"))) {
        throw new Error(`unexpected_streams:${lines.join("|")}`);
      }
    });
    // The product's encoder probe (ingest-core buildEncoderProbeArgs) is `-f lavfi -i color=… … -f null -`.
    await check("lavfi color source into a null sink (encoder probe shape)", async () => {
      const out = await run(ffmpeg, [
        "-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=10:d=1",
        "-c:v", "libx264", "-frames:v", "3", "-an", "-f", "null", "-",
      ]);
      if (out.code !== 0) throw new Error(out.stderr);
      const defaultEncoder = await run(ffmpeg, ["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=10:d=1", "-frames:v", "3", "-f", "null", "-"]);
      if (defaultEncoder.code !== 0) throw new Error(`null_sink_default_encoder:${defaultEncoder.stderr}`);
    });
    await check("libx265 + dash muxer + mp3 + mjpeg stills", async () => {
      const hevc = await run(ffmpeg, [
        "-hide_banner", "-v", "error", "-y",
        ...videoIn,
        "-c:v", "libx265", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-f", "dash", path.join(work, "out.mpd"),
      ]);
      if (hevc.code !== 0) throw new Error(`dash/libx265:${hevc.stderr}`);
      const mp3 = await run(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-i", wav, "-c:a", "libmp3lame", path.join(work, "a.mp3")]);
      if (mp3.code !== 0) throw new Error(`mp3:${mp3.stderr}`);
      const still = await run(ffmpeg, [
        "-hide_banner", "-v", "error", "-y",
        ...videoIn,
        "-vf", "scale=320:320:force_original_aspect_ratio=increase,crop=320:320",
        "-frames:v", "1", path.join(work, "still.jpg"),
      ]);
      if (still.code !== 0) throw new Error(`jpg:${still.stderr}`);
    });

    const mpvOut = await run(mpv, ["--version"], { cwd: work });
    await check("mpv runs on FFmpeg 8", async () => {
      if (!mpvOut.stdout.includes("FFmpeg version: 8.")) throw new Error(`not_ffmpeg_8:${mpvOut.stdout.split("\n").slice(0, 3).join(" | ") || mpvOut.stderr}`);
    });
    await check("mpv features", async () => {
      const verbose = await run(mpv, ["--no-config", "-v", "--version"]);
      const line = /\[cplayer\] List of enabled features: (.*)/.exec(`${verbose.stdout}\n${verbose.stderr}`)?.[1] ?? "";
      const features = line.split(/\s+/);
      const wanted = [...MPV_FEATURES.requiredFeatures, ...target.mpvRequiredFeatures];
      const missing = wanted.filter((feature) => !features.includes(feature));
      if (missing.length > 0) throw new Error(`features_missing:${missing.join(",")} (have: ${line})`);
    });
    await check("mpv video outputs, decoders, audio filters", async () => {
      const vo = await run(mpv, ["--no-config", "--vo=help"]);
      const voMissing = missingEntries([...MPV_FEATURES.requiredVideoOutputs, ...target.mpvRequiredVideoOutputs], parseMpvObjectHelp(vo.stdout));
      if (voMissing.length > 0) throw new Error(`vo_missing:${voMissing.join(",")}`);
      const vd = await run(mpv, ["--no-config", "--vd=help"]);
      const vdMissing = MPV_FEATURES.requiredDecoders.filter((name) => !new RegExp(`^\\s+${name}\\s+-\\s`, "m").test(vd.stdout));
      if (vdMissing.length > 0) throw new Error(`decoders_missing:${vdMissing.join(",")}`);
      const af = await run(mpv, ["--no-config", "--af=help"]);
      const afMissing = MPV_FEATURES.requiredAudioFilters.filter((name) => !new RegExp(`^\\s+${name}\\s`, "m").test(af.stdout));
      if (afMissing.length > 0) throw new Error(`audio_filters_missing:${afMissing.join(",")}`);
    });
    // The GPU path (#25) as listed by the binaries themselves: CI has no GPU, but a hwdec or GPU context missing
    // from these lists can never be picked at runtime, and mpv then decodes and draws on the CPU.
    await check("mpv hwdecs, GPU contexts; ffmpeg hwaccel methods", async () => {
      const hwdec = await run(mpv, ["--no-config", "--hwdec=help"]);
      const hwdecs = parseMpvHwdecHelp(hwdec.stdout);
      log(`[media-deps:verify] mpv hwdecs: ${[...hwdecs].join(",")}`);
      const hwdecsMissing = missingEntries(target.mpvRequiredHwdecs, hwdecs);
      if (hwdecsMissing.length > 0) throw new Error(`hwdecs_missing:${hwdecsMissing.join(",")} (have: ${[...hwdecs].join(",")})`);
      const context = await run(mpv, ["--no-config", "--gpu-context=help"]);
      const contexts = parseMpvObjectHelp(context.stdout);
      log(`[media-deps:verify] mpv GPU contexts: ${[...contexts].join(",")}`);
      const contextsMissing = missingEntries(target.mpvRequiredGpuContexts, contexts);
      if (contextsMissing.length > 0) throw new Error(`gpu_contexts_missing:${contextsMissing.join(",")} (have: ${[...contexts].join(",")})`);
      const hwaccels = await run(ffmpeg, ["-hide_banner", "-hwaccels"]);
      const methods = parseFfmpegHwaccels(hwaccels.stdout);
      log(`[media-deps:verify] ffmpeg hwaccel methods: ${[...methods].join(",")}`);
      const methodsMissing = missingEntries(target.ffmpegRequiredHwaccelMethods, methods);
      if (methodsMissing.length > 0) throw new Error(`hwaccel_methods_missing:${methodsMissing.join(",")} (have: ${[...methods].join(",")})`);
    });
    await check("mpv decodes the transcoded sample", async () => {
      const mp4 = path.join(work, "sample.mp4");
      if (!existsSync(mp4)) throw new Error("sample_missing");
      const out = await run(mpv, ["--no-config", "--vo=null", "--ao=null", "--length=1", mp4], { timeoutMs: 60_000 });
      if (out.code !== 0) throw new Error(`exit_${out.code}:${out.stderr}`);
    });

    await check("mpv IPC endpoint answers (with the product OSC)", async () => {
      const endpoint =
        target.ipc === "named-pipe"
          ? `\\\\.\\pipe\\sf-media-deps-verify-${process.pid}`
          : path.join(work, "mpv.sock");
      const args = [
        "--no-config", "--idle=yes", "--vo=null", "--ao=null", "--osc=no", "--load-scripts=no",
        "--msg-level=all=v", `--input-ipc-server=${endpoint}`,
        ...(options.oscScript && existsSync(options.oscScript) ? [`--script=${options.oscScript}`] : []),
      ];
      const output: string[] = [];
      // Spawned (not execFile): mpv stays up while the IPC endpoint is probed.
      const child = spawn(mpv, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env });
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString("utf8")));
      try {
        let reply: Record<string, unknown> | null = null;
        for (let attempt = 0; attempt < 40 && !reply; attempt++) {
          await sleep(250);
          try {
            reply = await mpvIpcRequest(endpoint, ["get_property", "mpv-version"], 3_000);
          } catch {
            // The server is not up yet.
          }
        }
        if (!reply) throw new Error(`no_ipc_reply:${output.join("").slice(-1500)}`);
        if (reply.error !== "success" || typeof reply.data !== "string" || !reply.data.startsWith("mpv ")) {
          throw new Error(`bad_ipc_reply:${JSON.stringify(reply)}`);
        }
        if (options.oscScript && existsSync(options.oscScript)) {
          const text = output.join("");
          if (/lua(?:jit)?\b.*error|error running script|failed to run script|Lua error/i.test(text)) {
            throw new Error(`osc_script_error:${text.slice(-1500)}`);
          }
        }
        return String(reply.data);
      } finally {
        child.kill();
      }
    });

    if (target.os === "macos") {
      await check("Mach-O: arch, minos, rpaths, links only bundle + /usr/lib + /System, signed, no symlinks", async () =>
        macBundleProblems(bundleDir, target).then((problems) => {
          if (problems.length > 0) throw new Error(problems.join("\n"));
        })
      );
    }

    if (target.os === "linux") {
      await check("no host libraries, no symlinks, no unresolved or unreachable libraries", async () => {
        const entries = readdirSync(binDir);
        const hostLibraries = findBundledHostLibraries(entries, target.hostLibraries ?? []);
        if (hostLibraries.length > 0) throw new Error(`host_libraries_bundled:${hostLibraries.join(",")}`);
        const links = entries.filter((name) => lstatSync(path.join(binDir, name)).isSymbolicLink());
        if (links.length > 0) throw new Error(`symlinks:${links.join(",")}`);
        for (const file of [ffmpeg, ffprobe, mpv]) {
          const ldd = await run("ldd", [file], { cwd: work });
          if (/not found/.test(ldd.stdout)) throw new Error(`unresolved:${path.basename(file)}:${ldd.stdout}`);
        }
        // A library only a host library needs is never loaded: the host library resolves it from the host.
        const roots = [ffmpeg, ffprobe, mpv].map((file) => path.basename(file));
        const elves = entries.filter((name) => name.includes(".so") || roots.includes(name));
        const needed = new Map(elves.map((name) => [name, readElfNeeded(readFileSync(path.join(binDir, name)))] as const));
        const unreachable = findUnreachableLibraries(needed, roots);
        if (unreachable.length > 0) throw new Error(`unreachable_libraries:${unreachable.join(",")}`);
      });
    }
    if (target.os === "windows") {
      await check("only ffmpeg's own DLLs ship (shader compilers and mingw runtime linked statically)", async () => {
        const foreign = findForeignDlls(readdirSync(binDir));
        if (foreign.length > 0) throw new Error(`foreign_dlls:${foreign.join(",")}`);
      });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { ok: failures.length === 0, failures, passed };
};
