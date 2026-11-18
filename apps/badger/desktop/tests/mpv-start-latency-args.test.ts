/**
 * @bugfix @regression-proof — issue #25 P13 (time to first frame 3-7 s on a
 * low-end box). Two mpv start costs found in the ultimate run's mpv logs:
 *
 * 1. FFmpeg's HLS demuxer `http_multiple` (auto → on for HTTP/1.1) opens the
 *    NEXT segment synchronously before it returns the first byte of the
 *    current one (libavformat/hls.c read_data → open_input(input_next)).
 *    The desktop playbackServer only answers once the whole object is fetched
 *    and decrypted, so every playlist probe at open, and the first read after
 *    the resume seek, blocked on a segment mpv did not need yet. Measured:
 *    57 % of every cold HLS open (median 0.57 s of 1.0 s, 41 opens).
 *    The playbackServer already prefetches the next keys itself, so the
 *    second connection buys nothing. Fix: `http_multiple=0`.
 *
 * 2. `--demuxer-cache-wait=yes` prefills the cache "before the initial seek
 *    triggered with --start" (mpv manual): 16 s (--cache-secs) from 0:00
 *    before the first frame, on every start, resume and ABR reload.
 *    #25 playable-start (Chris, 2026-10-09): no prefill and no initial
 *    threshold — playback starts as soon as the stream is playable and the
 *    cache fills to its 16 s readahead target in the background.
 *    The one exception is a resume INSIDE segment 0's first GOP
 *    (< MPV_RESUME_PREFILL_WINDOW_SECONDS): serving that `start=` seek from
 *    the seekable cache is the only way it lands exactly
 *    (@bugfix resume-first-gop-lands-one-gop-late, real-mpv proof in
 *    hls-seek-segment-boundary.test.ts). It prefills only the window
 *    (`cache-secs=<window>`); main restores the 16 s readahead on the
 *    file's first playback-restart (mpv-socket-client-observe.test.ts).
 *
 * The behavioural proof against a real mpv is mpv-hls-start-requests.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildExternalMpvArgs } from "@space/mpv";
import { buildLoadfileCommand, MPV_RESUME_PREFILL_WINDOW_SECONDS } from "@space/mpv-protocol";

const T = "[mpv-start-latency-args]";
const STREAM_URL = "http://127.0.0.1:3000/playback/hls/test/master.m3u8";

const dump = (label: string, value: unknown) => {
  try {
    console.error(`${T}:${label} snapshot ${JSON.stringify(value, null, 2)}`);
  } catch (err) {
    console.error(`${T}:${label} snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

describe("mpv start-latency args (#25 P13)", () => {
  const originalSecs = process.env.SF_MPV_STREAM_CACHE_SECS;

  beforeEach(() => {
    delete process.env.SF_MPV_STREAM_CACHE_SECS;
  });

  afterEach(() => {
    if (originalSecs === undefined) delete process.env.SF_MPV_STREAM_CACHE_SECS;
    else process.env.SF_MPV_STREAM_CACHE_SECS = originalSecs;
  });

  it("@bugfix @regression-proof disables FFmpeg HLS http_multiple and keeps the live-start options", () => {
    const args: string[] = buildExternalMpvArgs({ url: STREAM_URL });
    const lavfo = args.filter((a) => a.startsWith("--demuxer-lavf-o"));
    console.info(`${T}:http-multiple demuxer-lavf-o args=${JSON.stringify(lavfo)}`);
    if (lavfo.length !== 1 || !lavfo[0].includes("http_multiple=0")) dump("http-multiple", args);
    expect(lavfo).toHaveLength(1);
    const opts = lavfo[0].slice("--demuxer-lavf-o=".length).split(",");
    expect(opts).toContain("http_multiple=0");
    expect(opts).toContain("live_start_index=0");
    expect(opts).toContain("prefer_x_start=1");
  });

  // #25 playable-start (Chris, 2026-10-09): playback starts as soon as the
  // stream is playable; the cache fills to its --cache-secs readahead target
  // in the background. Throttled real-mpv run (2500 kbps stream over a 3.2
  // Mbps link): the 16 s prefill held the first frame 10.9 s, no wait showed
  // it in 0.35 s with zero stalls over 25 s of playback.
  it("@bugfix @regression-proof start-from-0 launch does not prefill before the first frame @req PLAY-ABR-05", () => {
    const args: string[] = buildExternalMpvArgs({ url: STREAM_URL });
    const cacheArgs = args.filter((a) => /cache/.test(a));
    console.info(`${T}:start-0 cache args=${JSON.stringify(cacheArgs)}`);
    if (args.some((a) => /cache-wait=yes|cache-pause-initial=yes/.test(a))) dump("start-0", args);
    expect(args).not.toContain("--demuxer-cache-wait=yes");
    expect(args).not.toContain("--cache-pause-initial=yes");
    // The readahead target stays: the cache keeps filling to 16 s.
    expect(args).toContain("--cache-secs=16");
  });

  it("@bugfix @regression-proof resume launch (--start>0) neither prefills from 0:00 nor waits at the resume point", () => {
    const args: string[] = buildExternalMpvArgs({ url: STREAM_URL, startTime: 569.77, paused: true });
    const cacheArgs = args.filter((a) => /cache|--start/.test(a));
    console.info(`${T}:resume cache args=${JSON.stringify(cacheArgs)}`);
    if (args.some((a) => /cache-wait=yes|cache-pause-initial=yes/.test(a))) dump("resume", args);
    expect(args).toContain("--start=569.77");
    expect(args).not.toContain("--demuxer-cache-wait=yes");
    expect(args).not.toContain("--cache-pause-initial=yes");
    expect(args).toContain("--cache-secs=16");
  });

  it("@bugfix @regression-proof disabling the stream cache disables both waits", () => {
    process.env.SF_MPV_STREAM_CACHE_SECS = "0";
    const resume: string[] = buildExternalMpvArgs({ url: STREAM_URL, startTime: 42 });
    const early: string[] = buildExternalMpvArgs({ url: STREAM_URL, startTime: 1 });
    const fresh: string[] = buildExternalMpvArgs({ url: STREAM_URL });
    console.info(`${T}:no-cache resume=${JSON.stringify(resume.filter((a) => /cache/.test(a)))} early=${JSON.stringify(early.filter((a) => /cache/.test(a)))} fresh=${JSON.stringify(fresh.filter((a) => /cache/.test(a)))}`);
    for (const args of [resume, early, fresh]) {
      expect(args).toContain("--cache=no");
      expect(args.some((a) => /cache-wait|cache-pause|cache-secs/.test(a))).toBe(false);
    }
  });

  it("@bugfix @regression-proof fresh, resume and ABR reload loadfiles start without a prefill, explicitly", () => {
    const resume = buildLoadfileCommand(STREAM_URL, "replace", { startSeconds: 569.77, paused: false });
    const fresh = buildLoadfileCommand(STREAM_URL, "replace", { startSeconds: 0, paused: false });
    const backdropFresh = buildLoadfileCommand(STREAM_URL, "replace", { startSeconds: null, paused: false });
    // reason=abr / quality pick: alive-mpv reload at the live position with
    // the OSC audio pick (the stress-run downshift that went 10-23 s silent).
    const abr = buildLoadfileCommand(STREAM_URL, "replace", { startSeconds: 18.3, audioTrack: 2 });
    console.info(`${T}:loadfile resume=${JSON.stringify(resume.command)} fresh=${JSON.stringify(fresh.command)} backdropFresh=${JSON.stringify(backdropFresh.command)} abr=${JSON.stringify(abr.command)}`);
    expect(resume.command).toEqual(["loadfile", STREAM_URL, "replace", -1, "start=569.77,demuxer-cache-wait=no,pause=no"]);
    // Explicit even from 0: an alive mpv launched with a first-GOP resume
    // carries --demuxer-cache-wait=yes globally, which a bare load inherits.
    expect(fresh.command).toEqual(["loadfile", STREAM_URL, "replace", -1, "demuxer-cache-wait=no,pause=no"]);
    expect(backdropFresh.command).toEqual(["loadfile", STREAM_URL, "replace", -1, "demuxer-cache-wait=no,pause=no"]);
    expect(abr.command).toEqual(["loadfile", STREAM_URL, "replace", -1, "start=18.3,demuxer-cache-wait=no,aid=2"]);
  });

  it("@bugfix @regression-proof the first-GOP prefill is shorter than the readahead target and mirrored by the launch args", () => {
    const args: string[] = buildExternalMpvArgs({ url: STREAM_URL, startTime: 1 });
    console.info(`${T}:prefill-window window=${MPV_RESUME_PREFILL_WINDOW_SECONDS} cache-secs=${JSON.stringify(args.filter((a) => a.startsWith("--cache-secs")))}`);
    expect(MPV_RESUME_PREFILL_WINDOW_SECONDS).toBeLessThan(16);
    expect(args).toContain(`--cache-secs=${MPV_RESUME_PREFILL_WINDOW_SECONDS}`);
  });

  it("@bugfix @regression-proof resume launch into the first GOP prefills only the prefill window", () => {
    for (const startTime of [1, 4.125, MPV_RESUME_PREFILL_WINDOW_SECONDS - 0.1]) {
      const args: string[] = buildExternalMpvArgs({ url: STREAM_URL, startTime, paused: true });
      const cacheArgs = args.filter((a) => /cache|--start/.test(a));
      console.info(`${T}:early-resume startTime=${startTime} cache args=${JSON.stringify(cacheArgs)}`);
      if (!args.includes("--demuxer-cache-wait=yes") || args.includes("--cache-secs=16")) dump(`early-resume-${startTime}`, args);
      expect(args).toContain(`--start=${startTime}`);
      expect(args).toContain("--demuxer-cache-wait=yes");
      expect(args).toContain(`--cache-secs=${MPV_RESUME_PREFILL_WINDOW_SECONDS}`);
      expect(args).not.toContain("--cache-secs=16");
      expect(args).not.toContain("--cache-pause-initial=yes");
    }
    const edge: string[] = buildExternalMpvArgs({ url: STREAM_URL, startTime: MPV_RESUME_PREFILL_WINDOW_SECONDS });
    console.info(`${T}:early-resume edge startTime=${MPV_RESUME_PREFILL_WINDOW_SECONDS} cache args=${JSON.stringify(edge.filter((a) => /cache/.test(a)))}`);
    expect(edge).not.toContain("--demuxer-cache-wait=yes");
    expect(edge).toContain("--cache-secs=16");
  });

  it("@bugfix @regression-proof resume loadfile into the first GOP prefills only the prefill window, explicitly", () => {
    const early = buildLoadfileCommand(STREAM_URL, "replace", { startSeconds: 1, paused: false });
    const edge = buildLoadfileCommand(STREAM_URL, "replace", { startSeconds: MPV_RESUME_PREFILL_WINDOW_SECONDS });
    console.info(`${T}:loadfile early=${JSON.stringify(early.command)} edge=${JSON.stringify(edge.command)}`);
    expect(early.command).toEqual([
      "loadfile", STREAM_URL, "replace", -1,
      `start=1,demuxer-cache-wait=yes,cache-secs=${MPV_RESUME_PREFILL_WINDOW_SECONDS},pause=no`,
    ]);
    expect(edge.command).toEqual([
      "loadfile", STREAM_URL, "replace", -1,
      `start=${MPV_RESUME_PREFILL_WINDOW_SECONDS},demuxer-cache-wait=no`,
    ]);
  });
});
