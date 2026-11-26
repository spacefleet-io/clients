import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * @bugfix @regression-proof mpv-bundled-no-https-backdrop-first-file
 *
 * Issue #25 finding F1 (ultimate stress suite). With a catalog backdrop on the
 * media, the renderer sends `launchExternalMpv({ backdropUrl: "data:image/jpeg;base64,...", url })`
 * and the main process used to launch mpv on the backdrop as its FIRST file
 * (`launchUrl = backdropUrl ?? payload.url`). The bundled mpv (linux-min-v1)
 * has NO https protocol and NO image decoders (video decoders: h264 + hevc
 * only), so it logged
 *   "No protocol handler found to open URL https://<image host>/..."
 *   "Exiting... (Errors when loading file)"
 * and exited before the renderer's `loadfile replace` swap could run — playback
 * never started for any media with a backdrop.
 *
 * Fix contract pinned here:
 *   1. In backdrop-handoff mode the launch plan carries NO file for mpv
 *      (`launchUrl: null`) — mpv starts idle with a forced window, and the
 *      renderer's `loadfile replace` swap starts the stream.
 *   2. The args built from that plan never contain the backdrop URL, any
 *      http(s) URL, or a positional file, and DO carry `--idle=yes`.
 *   3. Without a backdrop the plan is unchanged: stream URL launched directly
 *      with `--start` / `--pause` honoured, and no `--idle`.
 *   4. The IPC handler in `externalMpv.ts` actually routes through the plan
 *      (source pin) — it must not hand mpv `backdropUrl` again.
 */

const MPV_EXTERNAL = "@space/mpv/external";
const EXTERNAL_MPV_MAIN = new URL("../src/main/externalMpv.ts", import.meta.url);

const STREAM_URL = "http://127.0.0.1:3000/playback/hls/test/master.m3u8";
const BACKDROP_URL = "data:image/jpeg;base64,/9j/4AAQ";

const dump = (label: string, ctx: unknown) => {
  try {
    console.error(`=== [mpv-backdrop-launch-plan:${label}] snapshot ===`);
    console.error(JSON.stringify(ctx, null, 2));
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

// @req PLAY-OPEN-01[badger-desktop]
describe("@bugfix @regression-proof backdrop launch never hands mpv the https image", () => {
  it("backdrop-handoff plan launches mpv with no file (idle) and ignores the backdrop URL", async () => {
    const { planExternalMpvLaunch, buildExternalMpvArgs } = await import(MPV_EXTERNAL);
    console.info("[mpv-backdrop-launch-plan:handoff] planning launch with https backdrop");
    const plan = planExternalMpvLaunch({
      url: STREAM_URL,
      audioUrl: "http://127.0.0.1:3000/audio.m4a",
      backdropUrl: BACKDROP_URL,
      startTime: 42,
      paused: true,
    });
    const args: string[] = buildExternalMpvArgs({
      url: plan.launchUrl,
      audioUrl: plan.audioUrl,
      startTime: plan.startTime,
      paused: plan.paused,
      vo: "null",
    });
    const ctx = { plan, args };
    console.info(`[mpv-backdrop-launch-plan:handoff] plan=${JSON.stringify(plan)} argc=${args.length}`);
    if (
      plan.launchUrl !== null ||
      args.some((arg) => arg.includes("images.example.test")) ||
      !args.includes("--idle=yes")
    ) {
      dump("handoff", ctx);
    }
    expect(plan.backdropUsed).toBe(true);
    expect(plan.launchUrl).toBeNull();
    expect(args).toContain("--idle=yes");
    expect(args.filter((arg) => /^https?:\/\//.test(arg))).toEqual([]);
    expect(args.some((arg) => arg.includes("images.example.test"))).toBe(false);
    // Positional file (anything not starting with "--") must be absent.
    expect(args.filter((arg) => !arg.startsWith("--"))).toEqual([]);
    // Handoff owns start/pause via the per-load loadfile options.
    expect(args.some((arg) => arg.startsWith("--start="))).toBe(false);
    expect(args).not.toContain("--pause");
    expect(args.some((arg) => arg.startsWith("--audio-file="))).toBe(false);
  });

  it("blank backdrop URL falls back to launching the stream directly", async () => {
    const { planExternalMpvLaunch, buildExternalMpvArgs } = await import(MPV_EXTERNAL);
    const plan = planExternalMpvLaunch({
      url: STREAM_URL,
      backdropUrl: "   ",
      startTime: 42,
      paused: true,
    });
    const args: string[] = buildExternalMpvArgs({
      url: plan.launchUrl,
      startTime: plan.startTime,
      paused: plan.paused,
      vo: "null",
    });
    console.info(`[mpv-backdrop-launch-plan:direct] plan=${JSON.stringify(plan)}`);
    if (plan.launchUrl !== STREAM_URL || args.includes("--idle=yes")) dump("direct", { plan, args });
    expect(plan).toEqual({
      backdropUsed: false,
      launchUrl: STREAM_URL,
      audioUrl: undefined,
      startTime: 42,
      paused: true,
      extraArgs: [],
    });
    expect(args).not.toContain("--idle=yes");
    expect(args).toContain("--start=42");
    expect(args).toContain("--pause");
    expect(args[args.length - 1]).toBe(STREAM_URL);
  });

  // @bugfix @regression-proof mpv-backdrop-black-window (#25 P5/B3): the
  // handoff window used to stay black while the stream loaded. With a local
  // copy of the backdrop (main-process cache) mpv opens THAT file and holds
  // it until the renderer's `loadfile replace`.
  it("with a local backdrop copy mpv opens the still (held, idle after) and never the https URL", async () => {
    const { planExternalMpvLaunch, buildExternalMpvArgs } = await import(MPV_EXTERNAL);
    const backdropFile = "/home/user/.config/SpaceBadger/mpv-backdrops/0123abcd.jpg";
    const plan = planExternalMpvLaunch({
      url: STREAM_URL,
      audioUrl: "http://127.0.0.1:3000/audio.m4a",
      backdropUrl: BACKDROP_URL,
      backdropFile,
      startTime: 42,
      paused: true,
    });
    const args: string[] = buildExternalMpvArgs({
      url: plan.launchUrl,
      audioUrl: plan.audioUrl,
      startTime: plan.startTime,
      paused: plan.paused,
      vo: "null",
      extraArgs: plan.extraArgs,
    });
    console.info(`[mpv-backdrop-launch-plan:still] plan=${JSON.stringify(plan)} args=${JSON.stringify(args)}`);
    if (plan.launchUrl !== backdropFile || !args.includes("--image-display-duration=inf")) dump("still", { plan, args });
    expect(plan.backdropUsed).toBe(true);
    expect(plan.launchUrl).toBe(backdropFile);
    expect(args[args.length - 1]).toBe(backdropFile);
    expect(args.filter((arg) => !arg.startsWith("--"))).toEqual([backdropFile]);
    expect(args).toContain("--image-display-duration=inf");
    // A failed swap must leave mpv idle (handoff failure contract), not exit.
    expect(args).toContain("--idle=yes");
    expect(args.filter((arg) => /https?:\/\//.test(arg))).toEqual([]);
    expect(args.some((arg) => arg.startsWith("--start="))).toBe(false);
    expect(args).not.toContain("--pause");
    expect(args.some((arg) => arg.startsWith("--audio-file="))).toBe(false);
  });

  it("sf-mpv-external-play caches the backdrop locally and keeps the still's events from the handoff watcher", () => {
    const source = readFileSync(EXTERNAL_MPV_MAIN, "utf8");
    const pins = {
      cachesBackdrop: /cacheMpvBackdrop\(payload\.backdropUrl/.test(source),
      passesFile: /backdropFile,\s*\n\s*startTime: payload\.startTime/.test(source),
      planExtraArgs: /\.\.\.launchPlan\.extraArgs/.test(source),
      planAudio: /audioUrl: launchPlan\.audioUrl/.test(source),
      stillGate: (source.match(/if \(backdropStillShowing\)/g) ?? []).length >= 2,
    };
    console.info(`[mpv-backdrop-launch-plan:cache-source] pins=${JSON.stringify(pins)}`);
    if (Object.values(pins).some((ok) => !ok)) dump("cache-source", pins);
    expect(pins).toEqual({ cachesBackdrop: true, passesFile: true, planExtraArgs: true, planAudio: true, stillGate: true });
  });

  it("sf-mpv-external-play routes through planExternalMpvLaunch, not backdropUrl ?? url", () => {
    const source = readFileSync(EXTERNAL_MPV_MAIN, "utf8");
    console.info(`[mpv-backdrop-launch-plan:source] externalMpv.ts bytes=${source.length}`);
    if (/backdropUrl\s*\?\?\s*payload\.url/.test(source) || !/planExternalMpvLaunch\(/.test(source)) {
      const idx = source.indexOf("backdropUrl");
      dump("source", { around: source.slice(Math.max(0, idx - 200), idx + 600) });
    }
    expect(source).toMatch(/planExternalMpvLaunch\(/);
    expect(source).not.toMatch(/backdropUrl\s*\?\?\s*payload\.url/);
    expect(source).not.toMatch(/image-display-duration/);
  });
});
