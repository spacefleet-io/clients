/**
 * @bugfix hls-seek-to-segment-boundary-lands-one-gop-late
 * @regression-proof
 *
 * Ultimate-stress finding P10 (#25): "next chapter" to 180 s (= 15 x 12 s HLS
 * segments) went `seek to 179.979` -> `hr-seek, skipping to 180.000` ->
 * `playback restart complete @ 182.021`, one 2 s GOP late. Any seek into the
 * first GOP of a segment did the same (181 -> 182.021, 168.5 -> 170.021).
 *
 * Cause (FFmpeg HLS demuxer <= n9.0.2, fixed upstream only on master in
 * 848fb754dd): a backward video seek snaps to the EXTINF-derived segment start
 * and then discards packets until a keyframe with DTS >= that start. Our
 * EXTINF timeline is PTS-based, the demuxer baseline is the first packet read
 * (AAC audio, -21 ms priming), and the segment's opening keyframe has DTS one
 * B-frame reorder delay below its PTS, so the keyframe was discarded.
 *
 * Fix: playbackServer announces video segment boundaries
 * HLS_VIDEO_SEEK_LEAD_SECONDS early (+ cumulative ms rounding), and external
 * mpv runs with the same `--hr-seek-demuxer-offset`.
 *
 * Part 1 pins the served playlist (pure, always runs).
 * Part 2 drives the REAL vendored mpv against the REAL PlaybackServer with a
 * synthetic H.264 (B-frames, 2 s GOP) + AAC title packaged like ingest-core
 * (separate video/audio DASH, 12 s segments), and checks where hr-seeks land.
 * It skips loudly without mpv/ffmpeg.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireMediaBinary, writeToneWav } from "@space/media-deps";
import { buildExternalMpvArgs, MPV_HR_SEEK_DEMUXER_OFFSET_SECONDS, resolveExternalMpvTarget } from "@space/mpv";
import { buildLoadfileCommand } from "@space/mpv-protocol";
import { timelineDurations } from "./_helpers/dashTimeline";

vi.mock("../src/main/api", () => ({
  downloadStorageObjectViaTunnelToSink: vi.fn(),
}));

import {
  buildHlsExtinfDurations,
  HLS_VIDEO_SEEK_LEAD_SECONDS,
  PlaybackServer,
} from "../src/main/playbackServer";

const TAG = "[hls-seek-boundary]";
const SEGMENT_SECONDS = 12;

const extinfs = (playlist: string) =>
  playlist
    .split("\n")
    .filter((line) => line.startsWith("#EXTINF:"))
    .map((line) => Number(line.slice("#EXTINF:".length, line.indexOf(","))));

/** Boundary i as the FFmpeg HLS demuxer computes it: sum of EXTINF before i. */
const boundaryAt = (durations: number[], index: number) =>
  Math.round(durations.slice(0, index).reduce((sum, d) => sum + d, 0) * 1000) / 1000;

describe("HLS playlist segment boundaries (P10)", () => {
  it("keeps the @space/mpv hr-seek demuxer offset in lockstep with the video boundary lead", async () => {
    const args: string[] = buildExternalMpvArgs({});
    console.info(`${TAG} lead=${HLS_VIDEO_SEEK_LEAD_SECONDS} offset=${MPV_HR_SEEK_DEMUXER_OFFSET_SECONDS}`);
    expect(HLS_VIDEO_SEEK_LEAD_SECONDS).toBeGreaterThan(0);
    expect(MPV_HR_SEEK_DEMUXER_OFFSET_SECONDS).toBe(HLS_VIDEO_SEEK_LEAD_SECONDS);
    expect(args).toContain(`--hr-seek-demuxer-offset=${HLS_VIDEO_SEEK_LEAD_SECONDS}`);
  });

  it("announces every video boundary after the first `lead` early and keeps the total exact", () => {
    const durations = Array.from({ length: 30 }, (_, i) => (i === 0 ? 11.999 : SEGMENT_SECONDS));
    const out = buildHlsExtinfDurations(durations, 0.25);
    console.info(`${TAG} extinf head=${JSON.stringify(out.slice(0, 3))} tail=${JSON.stringify(out.slice(-2))}`);
    expect(boundaryAt(out, 15)).toBeCloseTo(179.999 - 0.25, 6);
    expect(boundaryAt(out, 30)).toBeCloseTo(boundaryAt(durations, 30), 6);
    expect(buildHlsExtinfDurations(durations, 0)).toEqual(durations);
  });

  it("does not drift the boundary map through per-segment ms rounding over a long title", () => {
    // AAC-ish 12.0106666 s segments: per-segment toFixed(3) drifted +0.33 ms
    // each, ~0.2 s after 600 segments.
    const durations = Array.from({ length: 600 }, () => 12.010666666666667);
    const out = buildHlsExtinfDurations(durations, 0);
    const exact = durations.reduce((sum, d) => sum + d, 0);
    const drift = Math.abs(boundaryAt(out, 600) - exact);
    console.info(`${TAG} 600-segment drift=${drift.toFixed(6)} s`);
    expect(drift).toBeLessThan(0.001);
  });

  it("serves the shifted map for video playlists and the plain map for audio", async () => {
    const server = new PlaybackServer();
    await server.start();
    try {
      const segments = (prefix: string, first: number) =>
        Array.from({ length: 20 }, (_, i) => ({
          key: `${prefix}/seg-${i}`,
          durationSeconds: i === 0 ? first : SEGMENT_SECONDS,
        }));
      const { id, url } = server.createHlsSession({
        videos: [
          {
            id: "v0",
            quality: "source",
            bitrateKbps: 4000,
            width: 1920,
            height: 1080,
            track: { initKey: "v/init", codecString: null, segments: segments("v", 11.999) },
          },
        ],
        audio: [
          {
            id: "a0",
            language: "en",
            label: "English",
            isDefault: true,
            track: { initKey: "a/init", codecString: null, segments: segments("a", 11.989) },
          },
        ],
      });
      const base = url.slice(0, url.lastIndexOf("/"));
      const video = await (await fetch(`${base}/video-v0.m3u8`)).text();
      const audio = await (await fetch(`${base}/audio-a0.m3u8`)).text();
      console.info(`${TAG} session=${id}\n--- video ---\n${video.split("\n").slice(0, 12).join("\n")}`);
      expect(boundaryAt(extinfs(video), 15)).toBeCloseTo(179.999 - HLS_VIDEO_SEEK_LEAD_SECONDS, 6);
      expect(boundaryAt(extinfs(video), 20)).toBeCloseTo(11.999 + 19 * SEGMENT_SECONDS, 6);
      expect(boundaryAt(extinfs(audio), 15)).toBeCloseTo(11.989 + 14 * SEGMENT_SECONDS, 6);
      const target = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(video)?.[1]);
      expect(Math.max(...extinfs(video))).toBeLessThanOrEqual(target);
    } finally {
      await server.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// Part 2: real mpv against the real PlaybackServer.
// ---------------------------------------------------------------------------

const mpvTarget = process.platform === "linux" ? resolveExternalMpvTarget() : null;
// The fixture needs libx264 (B-frames + fixed GOP); minimal ffmpeg builds lack it.
const ffmpegOk =
  spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }).stdout?.includes("libx264") ?? false;
requireMediaBinary("ffmpeg with libx264", ffmpegOk);
requireMediaBinary("mpv (shipped bundle)", Boolean(mpvTarget && mpvTarget.kind !== "fallback"));
const liveRunnable = Boolean(mpvTarget && mpvTarget.kind !== "fallback" && ffmpegOk);
if (!liveRunnable) {
  console.warn(
    `${TAG} SKIP live mpv part: platform=${process.platform} mpv=${mpvTarget?.kind ?? "n/a"} ffmpeg=${ffmpegOk}. Run \`bun run setup:binaries\`.`,
  );
}

// Real-clock waits are deliberate: this polls a separate mpv process (demuxer,
// decoder, IPC) whose clock fake timers cannot control. Every wait is a bounded
// poll on an observable condition.
const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

const ipc = (sock: string, command: unknown[]) => {
  const { promise, resolve, reject } = Promise.withResolvers<{ data?: unknown; error?: string }>();
  const client = createConnection(sock);
  let buf = "";
  const timer = setTimeout(() => {
    client.destroy();
    reject(new Error(`${TAG} ipc timeout ${JSON.stringify(command)}`));
  }, 5_000);
  client.on("connect", () => client.write(`${JSON.stringify({ command, request_id: 7 })}\n`));
  client.on("data", (chunk) => {
    buf += chunk.toString();
    for (const line of buf.split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { request_id?: number; data?: unknown; error?: string };
      if (msg.request_id === 7) {
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

const dash = (args: string[], outDir: string) => {
  mkdirSync(outDir, { recursive: true });
  const res = spawnSync("ffmpeg", [
    "-v", "error", "-y", ...args,
    "-f", "dash", "-seg_duration", String(SEGMENT_SECONDS), "-use_timeline", "1", "-use_template", "1",
    "-init_seg_name", "init-$RepresentationID$.mp4", "-media_seg_name", "seg-$Number%05d$.m4s",
    join(outDir, "manifest.mpd"),
  ]);
  if (res.status !== 0) throw new Error(`${TAG} ffmpeg dash failed: ${res.stderr?.toString()}`);
};

describe.skipIf(!liveRunnable)("hr-seek to an HLS segment boundary (real mpv + PlaybackServer)", () => {
  let dir = "";
  let server: PlaybackServer | null = null;
  let mpv: ChildProcess | null = null;
  let sock = "";
  let logFile = "";
  let streamUrl = "";
  const savedEnv = { ...process.env };

  const dumpLog = () => {
    try {
      const lines = readFileSync(logFile, "utf8").split("\n");
      return lines.filter((l) => /seek|restart|hr-seek|hls|error/i.test(l)).slice(-60).join("\n");
    } catch (err) {
      return `(no mpv log: ${err instanceof Error ? err.message : String(err)})`;
    }
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sf-hls-seek-"));
    const objects = join(dir, "objects");
    const src = join(dir, "src.mkv");
    // 240 s, 24 fps, H.264 High with 2 B-frames (has_b_frames=2) and a fixed
    // 48-frame (2 s) closed GOP like the ultimate fixtures; AAC 48 kHz audio
    // (1024-sample priming). 64x36 keeps the encode well under a second.
    // The shipped ffmpeg has no testsrc2/sine sources: flat `color` video and a looped wav tone written here.
    const tone = join(dir, "tone.wav");
    writeToneWav(tone, { hz: 440, seconds: 2 });
    const enc = spawnSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "color=c=black:s=64x36:r=24:d=240",
      "-stream_loop", "-1", "-i", tone,
      "-t", "240",
      "-c:v", "libx264", "-preset", "ultrafast", "-profile:v", "high", "-bf", "2", "-b_strategy", "0",
      "-g", "48", "-keyint_min", "48", "-sc_threshold", "0", "-x264-params", "open_gop=0",
      "-c:a", "aac", "-b:a", "64k", src,
    ]);
    if (enc.status !== 0) throw new Error(`${TAG} fixture encode failed: ${enc.stderr?.toString()}`);
    dash(["-i", src, "-map", "0:v:0", "-an", "-sn", "-dn", "-map_chapters", "-1", "-c:v", "copy"], join(objects, "v"));
    dash(["-i", src, "-map", "0:a:0", "-c:a", "copy", "-vn", "-sn", "-dn", "-map_chapters", "-1"], join(objects, "a"));
    const track = (kind: "v" | "a") => {
      const durations = timelineDurations(readFileSync(join(objects, kind, "manifest.mpd"), "utf8"));
      const files = readdirSync(join(objects, kind)).filter((f) => f.startsWith("seg-")).sort();
      expect(files.length).toBe(durations.length);
      return {
        initKey: `${kind}/init-0.mp4`,
        codecString: null,
        segments: files.map((f, i) => ({ key: `${kind}/${f}`, durationSeconds: durations[i]! })),
      };
    };
    process.env.SF_PLAYBACK_LOCAL_OBJECTS = "1";
    process.env.SF_PLAYBACK_LOCAL_OBJECTS_DIR = objects;
    server = new PlaybackServer();
    await server.start();
    server.setToken("test-token");
    const videoTrack = track("v");
    console.info(`${TAG} video segment durations head=${JSON.stringify(videoTrack.segments.slice(0, 3).map((s) => s.durationSeconds))}`);
    const { url } = server.createHlsSession({
      videos: [{ id: "v0", quality: "source", bitrateKbps: 300, width: 64, height: 36, track: videoTrack }],
      audio: [{ id: "a0", language: "en", label: "English", isDefault: true, track: track("a") }],
    });
    streamUrl = url;

    if (mpvTarget === null) throw new Error(`${TAG} live mpv part requires a resolved mpv target`);
    sock = join(dir, "mpv.sock");
    logFile = join(dir, "mpv.log");
    const env = {
      ...process.env,
      ...(mpvTarget.kind === "bundle" && mpvTarget.libDirs.length > 0
        ? { LD_LIBRARY_PATH: [mpvTarget.libDirs.join(":"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }
        : {}),
    };
    const args = [
      "--no-config", "--idle=yes", "--keep-open=yes", "--pause", "--vo=null", "--ao=null", "--no-terminal",
      "--load-scripts=no", "--msg-level=all=v,ffmpeg/demuxer=debug",
      // Every seek must reach the HLS demuxer: with the seekable cache on, a
      // target already cached by the previous seek bypasses the bug entirely.
      "--demuxer-seekable-cache=no",
      // Same seek knob production passes (buildExternalMpvArgs); undefined pre-fix.
      ...(MPV_HR_SEEK_DEMUXER_OFFSET_SECONDS ? [`--hr-seek-demuxer-offset=${MPV_HR_SEEK_DEMUXER_OFFSET_SECONDS}`] : []),
      `--log-file=${logFile}`, `--input-ipc-server=${sock}`, url,
    ];
    console.info(`${TAG} mpv bin=${mpvTarget.bin} kind=${mpvTarget.kind} url=${url}`);
    console.info(`${TAG} mpv log file: ${logFile}`);
    mpv = spawn(mpvTarget.bin, args, { stdio: "ignore", detached: true, env });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !(existsSync(logFile) && readFileSync(logFile, "utf8").includes("playback restart complete"))) {
      if (mpv.exitCode !== null) throw new Error(`${TAG} mpv exited early code=${mpv.exitCode}\n${dumpLog()}`);
      await sleep(100);
    }
    if (!readFileSync(logFile, "utf8").includes("playback restart complete")) {
      throw new Error(`${TAG} mpv never started playback\n${dumpLog()}`);
    }
  }, 120_000);

  afterAll(async () => {
    if (logFile) spawnSync("pkill", ["-KILL", "-f", logFile]);
    if (mpv?.pid) {
      try {
        process.kill(-mpv.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await server?.stop();
    process.env = savedEnv;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** hr-seek like a chapter jump / resume, return where playback restarted. */
  const seekAndLand = async (target: number) => {
    const before = readFileSync(logFile, "utf8").length;
    await ipc(sock, ["seek", String(target), "absolute+exact"]);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const tail = readFileSync(logFile, "utf8").slice(before);
      const m = /playback restart complete @ (-?[0-9.]+)/.exec(tail);
      if (m) return Number(m[1]);
      await sleep(50);
    }
    throw new Error(`${TAG} no playback restart after seek ${target}\n${dumpLog()}`);
  };

  // 180 = chapter at 15 x 12 s (the P10 case); 181/168.5 = inside a segment's
  // first GOP; 179.9 = inside the lead window before a boundary; 200/150 =
  // controls that already landed exactly.
  it.each([180, 181, 168.5, 179.9, 200, 150])("hr-seek to %s s lands on target (within one frame)", async (target) => {
    const landed = await seekAndLand(target);
    const timePos = (await ipc(sock, ["get_property", "time-pos"])).data;
    console.info(`${TAG} seek target=${target} restart@${landed} time-pos=${String(timePos)}`);
    // mpv's timeline carries the AAC priming offset (+0.021 s); one frame = 0.042 s.
    if (Math.abs(landed - target) > 0.1) console.error(`${TAG} FAIL dump target=${target}\n${dumpLog()}`);
    expect(Math.abs(landed - target)).toBeLessThanOrEqual(0.1);
  }, 30_000);

  // @bugfix resume-first-gop-lands-one-gop-late (#25, desktop-e2e run 8113,
  // skip-markers "RESUME launch before intro"). A seek BACK into segment 0
  // snaps to its start (FFmpeg hls_read_seek: first_timestamp, 0 before any
  // packet was read) and then drops packets until a keyframe with DTS >= 0 —
  // and the first keyframe's DTS is negative (B-frame delay), so playback
  // starts one GOP late. The P10 lead cannot help: there is no boundary
  // before segment 0 to announce early. A resume load into that window must
  // prefill from 0:00 so mpv serves the initial `start=` seek from its
  // seekable cache — only the short prefill window (`cache-secs=<window>`,
  // #25 playable-start), not the 16 s readahead. Uses the production per-load
  // + cache options: the launch globals first, the per-load options after
  // them (mpv keeps the last duplicate, as a real loadfile overrides globals).
  it("@bugfix @regression-proof resume loadfile into the first segment's first GOP lands on target", async () => {
    const target = 1;
    const launchArgs: string[] = buildExternalMpvArgs({ url: streamUrl });
    const cacheOpts = launchArgs
      .filter((a) => /^--(cache|cache-secs|demuxer-max-bytes|demuxer-max-back-bytes)=/.test(a))
      .map((a) => a.slice(2));
    const load = buildLoadfileCommand(streamUrl, "replace", { startSeconds: target, paused: false });
    const perLoad = [...cacheOpts, "demuxer-seekable-cache=auto", String(load.command[4] ?? "")].join(",");
    console.info(`${TAG} resume loadfile per-load options=${perLoad}`);
    const before = readFileSync(logFile, "utf8").length;
    const res = await ipc(sock, ["loadfile", streamUrl, "replace", -1, perLoad]);
    console.info(`${TAG} resume loadfile ipc reply=${JSON.stringify(res)}`);
    let landed: number | null = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && landed === null) {
      const m = /playback restart complete @ (-?[0-9.]+)/.exec(readFileSync(logFile, "utf8").slice(before));
      if (m) landed = Number(m[1]);
      else await sleep(50);
    }
    console.info(`${TAG} resume loadfile target=${target} restart@${String(landed)}`);
    if (landed === null || Math.abs(landed - target) > 0.1) console.error(`${TAG} FAIL dump resume target=${target}\n${dumpLog()}`);
    expect(landed).not.toBeNull();
    expect(Math.abs(landed! - target)).toBeLessThanOrEqual(0.1);
  }, 30_000);
});
