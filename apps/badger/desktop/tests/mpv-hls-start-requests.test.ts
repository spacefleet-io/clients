/**
 * @bugfix @regression-proof — issue #25 P13, behavioural proof against a REAL
 * mpv (the arg-level contract is mpv-start-latency-args.test.ts).
 *
 * A local HLS server mimics the desktop playbackServer: a media segment's
 * response (headers included) only starts once the whole object is
 * "fetched" (a fixed delay here). mpv is launched idle with the product args
 * and gets the product's resume loadfile (backdrop handoff), exactly like
 * useMpvPlaybackEngine does. The assertions read mpv's own log, so they are
 * about WHICH segments mpv waited for, not wall-clock time; "before/after an
 * mpv event" is the log's line order, never its timestamps (#358, runLoad):
 *
 *  (a) while opening the HLS master, mpv probes init + first segment of every
 *      rendition. Pre-fix FFmpeg's http_multiple also opened (and blocked on)
 *      the SECOND segment of each rendition.
 *  (b) on a resume load, mpv must not download the head of the file before
 *      the resume seek. Pre-fix --demuxer-cache-wait=yes prefilled 16 s from
 *      0:00 and the seek threw it away.
 *  (c) #25 playable-start: a fresh load from 0:00 shows its first frame as
 *      soon as the stream is playable, before the 16 s readahead is fetched;
 *      the readahead still fills afterwards. Pre-fix --demuxer-cache-wait=yes
 *      held the first frame until 16 s were cached.
 *
 * Needs ffmpeg (libx264 + aac) and a runnable vendored mpv
 * (`bun run ensure:test-binaries`); without them the suite is skipped with a
 * loud reason (desktop CI has neither, it runs the arg-level contract).
 *
 * Real timers are deliberate: the server delay models a fetch latency that an
 * external mpv process must observe, and mpv's IPC socket / log file are polled
 * because a separate process exposes no in-test signal to await.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMediaBinary, writeToneWav } from "@space/media-deps";
import { buildExternalMpvArgs, resolveExternalMpvTarget } from "@space/mpv";
import { buildLoadfileCommand } from "@space/mpv-protocol";
import { writeVodPlaylist } from "./_helpers/dashTimeline";

const T = "[mpv-hls-start-requests]";
const SEGMENT_SECONDS = 6;
const DURATION_SECONDS = 48;
const RESUME_SECONDS = 31; // inside segment 5 (30-36 s)
const SEGMENT_DELAY_MS = 250;

const target = resolveExternalMpvTarget();
const ffmpegOk = spawnSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" }).status === 0;
const mpvOk =
  target.kind !== "fallback" &&
  spawnSync(target.bin, ["--version"], {
    env: { ...process.env, LD_LIBRARY_PATH: [target.libDirs.join(":"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") },
    stdio: "ignore",
    timeout: 15_000,
  }).status === 0;
requireMediaBinary("ffmpeg", ffmpegOk);
requireMediaBinary("mpv (shipped bundle)", mpvOk);
const skipReason = !ffmpegOk ? "ffmpeg not on PATH" : !mpvOk ? `no runnable vendored mpv (resolved ${target.kind} ${target.bin})` : null;
if (skipReason) console.warn(`${T} SKIPPED: ${skipReason} — run \`bun run ensure:test-binaries\` and install ffmpeg to exercise it`);

describe.skipIf(skipReason !== null)("@bugfix @regression-proof real mpv HLS start: no blocking on unneeded segments (#25 P13)", () => {
  let dir = "";
  let server: Server | null = null;
  let baseUrl = "";
  let mpv: ChildProcess | null = null;
  const served: string[] = [];

  const encode = (out: string, args: string[]) => {
    mkdirSync(out, { recursive: true });
    const r = spawnSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", ...args,
      "-f", "dash", "-seg_duration", String(SEGMENT_SECONDS), "-use_template", "1", "-use_timeline", "1",
      "-init_seg_name", "init.mp4", "-media_seg_name", "seg$Number%03d$.m4s", join(out, "manifest.mpd"),
    ], { encoding: "utf8", timeout: 60_000 });
    console.info(`${T} ffmpeg ${out} status=${r.status} ${r.stderr?.slice(-400) ?? ""}`);
    if (r.status !== 0) throw new Error(`fixture encode failed for ${out}: ${r.stderr}`);
    writeVodPlaylist(out);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sf-hls-start-"));
    console.info(`${T} fixture dir ${dir}`);
    // The shipped ffmpeg has no testsrc2/sine sources: flat `color` video and looped wav tones written here.
    encode(join(dir, "v"), [
      "-f", "lavfi", "-i", `color=c=black:s=160x90:r=24:d=${DURATION_SECONDS}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0", "-pix_fmt", "yuv420p",
    ]);
    for (const [name, hz] of [["a0", 440], ["a1", 660]] as const) {
      const tone = join(dir, `${name}.wav`);
      writeToneWav(tone, { hz, seconds: 2 });
      encode(join(dir, name), ["-stream_loop", "-1", "-i", tone, "-t", String(DURATION_SECONDS), "-c:a", "aac", "-b:a", "64k"]);
    }
    server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (path === "/master.m3u8") {
        res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" });
        res.end([
          "#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS",
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="${baseUrl}/a0/index.m3u8"`,
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="French",DEFAULT=NO,AUTOSELECT=YES,URI="${baseUrl}/a1/index.m3u8"`,
          `#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="avc1.42c00c,mp4a.40.2",AUDIO="audio",RESOLUTION=160x90`,
          `${baseUrl}/v/index.m3u8`, "",
        ].join("\n"));
        return;
      }
      const file = join(dir, path);
      if (!/^\/(v|a0|a1)\/[\w.]+$/.test(path) || !existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      const body = readFileSync(file);
      // Like playbackServer: a media object answers only once fully fetched.
      const delay = path.endsWith(".m4s") ? SEGMENT_DELAY_MS : 0;
      served.push(`${path} delay=${delay}`);
      setTimeout(() => {
        res.writeHead(200, { "content-length": String(body.length) });
        res.end(body);
      }, delay);
    });
    const { promise, resolve } = Promise.withResolvers<void>();
    server.listen(0, "127.0.0.1", () => resolve());
    await promise;
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    console.info(`${T} server ${baseUrl}`);
  }, 120_000);

  /** The AppImage target runs mpv under a junest wrapper: killing only the
   * spawned pid left the real mpv playing on after the test (found orphaned
   * in the test's systemd scope). Kill the whole process group instead. */
  const stopMpv = (label: string) => {
    if (!mpv?.pid) return;
    try {
      process.kill(-mpv.pid, "SIGKILL");
      console.info(`${T}:${label} killed mpv process group ${mpv.pid}`);
    } catch {
      // already gone
    }
    mpv = null;
  };

  afterAll(() => {
    stopMpv("afterAll");
    server?.close();
    // SF_TEST_KEEP_FIXTURE=1 keeps the fixture + mpv.log for post-mortem.
    if (dir && process.env.SF_TEST_KEEP_FIXTURE === "1") console.info(`${T} kept ${dir}`);
    else if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Launch mpv idle with the product args, send one product loadfile, and
   * parse mpv's log up to the first frame — or, with `afterFirstFrame`, until
   * that log predicate also holds (bounded). */
  const runLoad = async (label: string, startSeconds: number | null, afterFirstFrame?: (log: string) => boolean) => {
    const sock = join(dir, `mpv-${label}.sock`);
    const logFile = join(dir, `mpv-${label}.log`);
    served.length = 0;
    const args = buildExternalMpvArgs({ vo: "null", hwdec: "no", extraArgs: ["--ao=null"], logFile });
    args.unshift(`--input-ipc-server=${sock}`);
    console.info(`${T}:${label} launching ${target.kind} ${target.bin}; mpv log ${logFile}; cache args ${JSON.stringify(args.filter((a) => /cache/.test(a)))}`);
    mpv = spawn(target.bin, args, {
      env: { ...process.env, LD_LIBRARY_PATH: [target.libDirs.join(":"), process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") },
      stdio: "ignore",
      detached: true,
    });
    const readyBy = Date.now() + 20_000;
    while (!existsSync(sock) && Date.now() < readyBy) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(sock), "mpv IPC socket never appeared").toBe(true);
    const client = connect(sock);
    const connected = Promise.withResolvers<void>();
    client.once("connect", () => connected.resolve());
    client.once("error", (err) => connected.reject(err));
    await connected.promise;
    const load = buildLoadfileCommand(`${baseUrl}/master.m3u8`, "replace", { startSeconds, paused: false });
    console.info(`${T}:${label} sending ${JSON.stringify(load)}`);
    client.write(`${JSON.stringify(load)}\n`);

    let log = "";
    const doneBy = Date.now() + 30_000;
    while (Date.now() < doneBy) {
      await new Promise((r) => setTimeout(r, 100));
      log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
      if (log.includes("first video frame after restart shown")) break;
    }
    // The readahead fills only AFTER the first frame, in mpv's own time: poll
    // its log (bounded) for the caller's post-first-frame condition.
    const settledBy = Date.now() + 10_000;
    while (afterFirstFrame && !afterFirstFrame(log) && Date.now() < settledBy) {
      await new Promise((r) => setTimeout(r, 100));
      log = readFileSync(logFile, "utf8");
    }
    console.info(`${T}:${label} post-first-frame condition ${afterFirstFrame ? afterFirstFrame(log) : "n/a"}`);
    client.destroy();
    stopMpv(label);

    // Event order is the LINE order of mpv's log, never its timestamps: mpv's
    // log-file thread stamps each line with the time it WRITES it
    // (common/msg.c log_file_thread: mp_time_sec() at fprintf), not when it
    // was emitted. Under CPU load that thread lags and stamps a backlog with
    // one time, so "Opening done" and the post-seek requests after it read as
    // simultaneous (issue #358: segs 4/5 "at" openDoneTs 2.051). The file
    // buffer is a FIFO that blocks rather than drops, so line order is the
    // emission order across mpv's threads.
    type Line = { idx: number; ts: number; text: string };
    const lines: Line[] = log.split("\n").flatMap((text) => {
      const m = text.match(/^\[\s*([\d.]+)\]/);
      return m ? [{ ts: Number(m[1]), text }] : [];
    }).map((l, idx) => ({ idx, ...l }));
    const atLine = (needle: string) => lines.find((l) => l.text.includes(needle)) ?? null;
    const loadTs = atLine("Run command: loadfile")?.ts ?? null;
    const openDone = atLine("Opening done");
    const seek = atLine("hr-seek, skipping to");
    const firstFrame = atLine("first video frame after restart shown");
    const [openDoneTs, seekTs, firstFrameTs] = [openDone, seek, firstFrame].map((l) => l?.ts ?? null);
    const segRequests = lines.flatMap((l) => {
      const m = l.text.match(/hls: HLS request for url '[^']*\/(v|a0|a1)\/seg(\d+)\.m4s'/);
      return m ? [{ idx: l.idx, ts: l.ts, track: m[1], seg: Number(m[2]) }] : [];
    });
    const timing = {
      loadTs, openDoneTs, seekTs, firstFrameTs,
      openMs: loadTs != null && openDoneTs != null ? Math.round((openDoneTs - loadTs) * 1000) : null,
      firstFrameMs: loadTs != null && firstFrameTs != null ? Math.round((firstFrameTs - loadTs) * 1000) : null,
    };
    console.info(`${T}:${label} timing ${JSON.stringify(timing)}`);
    console.info(`${T}:${label} mpv segment requests ${JSON.stringify(segRequests)}`);
    console.info(`${T}:${label} server log\n${served.join("\n")}`);
    return { lines, openDone, seek, firstFrame, segRequests };
  };

  it("@bugfix @regression-proof resume loadfile: open probes only first segments, no head-of-file prefill before the seek", async () => {
    const { lines, openDone, seek, firstFrame, segRequests } = await runLoad("resume", RESUME_SECONDS);
    const resumeSeg = Math.floor(RESUME_SECONDS / SEGMENT_SECONDS);
    // Requests logged before "Opening done", i.e. issued while opening.
    const probeExtra = openDone == null ? [] : segRequests.filter((r) => r.idx < openDone.idx && r.seg > 0);
    // Segments well before the resume point (one segment of slack for an
    // hr-seek demuxer offset that legitimately starts reading a bit earlier).
    const headPrefill = seek == null ? [] : segRequests.filter((r) => r.idx < seek.idx && r.seg > 0 && r.seg < resumeSeg - 1);
    const firstFrameTs = firstFrame?.ts ?? null;
    if (firstFrameTs == null || probeExtra.length || headPrefill.length) {
      console.error(`${T} FAIL dump: probeExtra=${JSON.stringify(probeExtra)} headPrefill=${JSON.stringify(headPrefill)}\n--- mpv log tail ---\n${lines.slice(-60).map((l) => l.text).join("\n")}`);
    }
    expect(firstFrameTs, "mpv never showed a first frame").not.toBeNull();
    expect(probeExtra, "open blocked on a rendition's SECOND segment (FFmpeg http_multiple)").toEqual([]);
    expect(headPrefill, "resume prefilled the head of the file before the seek (demuxer-cache-wait)").toEqual([]);
  }, 90_000);

  // #25 playable-start (Chris, 2026-10-09): a start from 0:00 shows its first
  // frame as soon as the stream is playable; the cache fills to its 16 s
  // readahead afterwards. Pre-fix `--demuxer-cache-wait=yes` held the first
  // frame until 16 s were cached: segments 0-2 (0-18 s) of every track were
  // fetched first, each answering only after SEGMENT_DELAY_MS.
  it("@bugfix @regression-proof fresh loadfile from 0:00: first frame before the readahead segments are fetched", async () => {
    // 16 s of readahead reaches into segment 2 (12-18 s): no segment that
    // far may be requested before the first frame.
    const prefillSeg = Math.floor(16 / SEGMENT_SECONDS);
    const readaheadRe = new RegExp(`hls: HLS request for url '[^']*/v/seg0*${prefillSeg}\\.m4s'`);
    const { lines, firstFrame, segRequests } = await runLoad("fresh", null, (log) => readaheadRe.test(log));
    const firstFrameTs = firstFrame?.ts ?? null;
    const prefilled = firstFrame == null ? [] : segRequests.filter((r) => r.idx < firstFrame.idx && r.seg >= prefillSeg);
    if (firstFrameTs == null || prefilled.length) {
      console.error(`${T}:fresh FAIL dump: prefilled=${JSON.stringify(prefilled)}\n--- mpv log tail ---\n${lines.slice(-60).map((l) => l.text).join("\n")}`);
    }
    expect(firstFrameTs, "mpv never showed a first frame").not.toBeNull();
    expect(prefilled, "fresh start prefilled the 16 s readahead before the first frame (demuxer-cache-wait)").toEqual([]);
    // The readahead still fills afterwards (the cache target is unchanged).
    expect(segRequests.some((r) => r.track === "v" && r.seg >= prefillSeg), "readahead never fetched past the first frame").toBe(true);
  }, 90_000);
});
