import { getDesktopPlatform } from "@space/desktop-platform";
import type { MpvWindow } from "@space/desktop-platform";
import {
  resolveMpvIcon,
  resolveMpvOscScript,
  resolveMpvOscSelectScript,
  resolveMpvInputConf,
  resolveMpvTog4in1FontsDir,
  resolveMpvTog4in1Script,
} from "./index";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ExternalMpvLaunchOptions = {
  /**
   * File mpv opens at launch. `null`/omitted = launch IDLE (`--idle=yes`
   * with the forced window): no file is opened and the caller loads the
   * stream afterwards over IPC (`loadfile ... replace`).
   */
  url?: string | null;
  audioUrl?: string | null;
  startTime?: number | null;
  paused?: boolean;
  vo?: string;
  hwdec?: string;
  title?: string;
  extraArgs?: string[];
  disableDefaults?: boolean;
  logFile?: string | null;
  appId?: string;
  /**
   * The gateway's high-traffic playback buffer cap in seconds (STOR-BW-01);
   * `null`/omitted = normal traffic, the stream cache keeps its full target.
   */
  playbackBufferSeconds?: number | null;
  /** The mpv that will run (asked whether it has Wayland on a Wayland-only session); default the resolved one. */
  target?: ResolvedExternalMpvTarget;
};

export type ExternalMpvLaunchPlanInput = {
  url: string;
  audioUrl?: string | null;
  backdropUrl?: string | null;
  /** Local copy of `backdropUrl` (main-process cache); `null` = not available. */
  backdropFile?: string | null;
  startTime?: number | null;
  paused?: boolean;
};

export type ExternalMpvLaunchPlan = {
  /** True when the renderer will swap in the stream over IPC after launch. */
  backdropUsed: boolean;
  /** File to open at launch; `null` = launch idle (see `ExternalMpvLaunchOptions.url`). */
  launchUrl: string | null;
  audioUrl: string | undefined;
  startTime: number | undefined;
  paused: boolean | undefined;
  /** Extra mpv args the plan needs (backdrop still: hold it + stay up after it). */
  extraArgs: string[];
};

/**
 * Decide what mpv is launched on.
 *
 * A `backdropUrl` means the renderer runs the backdrop-then-stream handoff:
 * mpv comes up first (so the Electron window can hide immediately) and the
 * renderer then issues `loadfile <stream> replace` with the per-load
 * `start=`/`pause=`, so `--start` / `--pause` / `--audio-file` are omitted.
 *
 * mpv only ever opens the backdrop as a LOCAL FILE (`backdropFile`, cached by
 * the main process): the https image URL made the old bundle exit "Errors when
 * loading file" before the swap (no https, no image decoders;
 * @bugfix mpv-bundled-no-https-backdrop-first-file, issue #25 F1). The bundle
 * now decodes png/jpeg/webp, so the still is shown while the stream loads
 * (`--image-display-duration=inf`) instead of a black window
 * (@bugfix mpv-backdrop-black-window, #25 P5/B3). `--idle=yes` keeps the
 * handoff's failure contract: a failed swap leaves mpv idle, never exits.
 * With no local copy the window opens idle (black) as before.
 */
export const planExternalMpvLaunch = (input: ExternalMpvLaunchPlanInput): ExternalMpvLaunchPlan => {
  const backdropUsed = Boolean(input.backdropUrl?.trim());
  if (backdropUsed) {
    const backdropFile = input.backdropFile?.trim() || null;
    return {
      backdropUsed,
      launchUrl: backdropFile,
      audioUrl: undefined,
      startTime: undefined,
      paused: undefined,
      extraArgs: backdropFile ? ["--idle=yes", "--image-display-duration=inf"] : [],
    };
  }
  return {
    backdropUsed,
    launchUrl: input.url,
    audioUrl: input.audioUrl ?? undefined,
    startTime: input.startTime ?? undefined,
    paused: input.paused,
    extraArgs: [],
  };
};

export type ResolvedExternalMpvTarget = {
  bin: string;
  kind: "system" | "bundle" | "fallback";
  libDirs: string[];
};

/** Test/host injection seam for {@link resolveExternalMpvTarget}; every field defaults to the real process. */
export type ExternalMpvTargetOptions = {
  env?: NodeJS.ProcessEnv;
  appRoot?: string;
  cwd?: string;
};

/**
 * SpaceBadger ships its own mpv (the packages/media-deps bundle) so playback behaves
 * identically across hosts. We deliberately do NOT auto-discover a system mpv
 * from PATH or /usr/bin — an arbitrary host mpv (wrong version, different OSC,
 * no libplacebo) would silently preempt the controlled binary. The only system
 * binary honored is an EXPLICIT SF_MPV_EXTERNAL_BIN / SF_MPV_SYSTEM_BIN (in that
 * order), which an operator/dev sets deliberately as an override. With no vendored binary and no explicit override
 * the resolver returns the `fallback` sentinel, which the desktop startup check
 * reports as a "missing required bundled binaries" error in the app logs — it
 * never silently spawns a PATH `mpv`.
 */
const resolveExplicitSystemMpvBinary = (env: NodeJS.ProcessEnv) => {
  for (const name of ["SF_MPV_EXTERNAL_BIN", "SF_MPV_SYSTEM_BIN"] as const) {
    const fromEnv = env[name]?.trim();
    if (fromEnv && existsSync(fromEnv)) return fromEnv;
  }
  return null;
};

export const resolveExternalMpvTarget = (
  options?: ExternalMpvTargetOptions
): ResolvedExternalMpvTarget => {
  const env = options?.env ?? process.env;
  const explicitSystem = resolveExplicitSystemMpvBinary(env);
  // The media-deps bundle (vendor/deps/<os>-<arch>/bin or <resources>/deps/bin):
  // mpv plus every library it loads, next to it. No glibc is shipped, so there
  // is nothing to probe: the binary runs on any host the bundle's min glibc fits.
  const bundle = getDesktopPlatform().binaries.resolveAll("mpv", {
    env,
    // Packaged: SF_APP_ROOT (set by the desktop main process) is <resources>/app.asar; deps/ sits beside it.
    appRoot: env.SF_APP_ROOT?.trim() || options?.appRoot,
    cwd: options?.cwd,
  })[0];

  // An explicit operator override wins, then the bundle. We never auto-discover
  // a PATH/usr system mpv — see resolveExplicitSystemMpvBinary.
  if (explicitSystem) return { bin: explicitSystem, kind: "system", libDirs: [] };
  if (bundle) return { bin: bundle.path, kind: "bundle", libDirs: bundle.libDirs ?? [] };
  // No bundled binary and no explicit override: surface the failure sentinel.
  // The desktop startup gate (index.ts) maps kind="fallback" to a loud modal
  // pointing at `bun run setup:binaries`; nothing silently spawns PATH mpv.
  return { bin: "mpv", kind: "fallback", libDirs: [] };
};

export const resolveExternalMpvBinary = () => resolveExternalMpvTarget().bin;

type ExternalMpvEnvResult = {
  env: NodeJS.ProcessEnv;
  dataDir?: string;
  appId: string;
};

export const buildExternalMpvEnv = (options?: { appId?: string }) => {
  const appId = options?.appId ?? "spacebadger";
  const dataDir =
    process.env.SF_MPV_XDG_DATA_HOME?.trim() ||
    join(tmpdir(), "sf-mpv-xdg", appId);
  mkdirSync(dataDir, { recursive: true });
  const env = getDesktopPlatform().shell.prepareMpvWindow({
    appId,
    iconPath: resolveMpvIcon(),
    dataDir,
    env: process.env,
  });
  return { env, dataDir, appId };
};

/** Env for launching `target`: the bundle gets its lib dirs. */
export const buildExternalMpvTargetEnv = (
  target: ResolvedExternalMpvTarget,
  base: { env: NodeJS.ProcessEnv },
): NodeJS.ProcessEnv => {
  if (target.kind !== "bundle" || target.libDirs.length === 0) return base.env;
  return getDesktopPlatform().binaries.launchEnv({ libDirs: target.libDirs }, base.env);
};

/** The gpu contexts `mpv --gpu-context=help` lists (`x11egl`, `wayland`, `waylandvk`, ...); `auto` left out. */
export const parseMpvGpuContexts = (output: string): string[] =>
  output
    .split("\n")
    .map((line) => /^\s+([a-z0-9_-]+)\s/i.exec(line)?.[1] ?? null)
    .filter((name): name is string => name !== null && name !== "auto");

export type MpvGpuContextProbe = (target: ResolvedExternalMpvTarget) => { output: string; error: string | null };

const runMpvGpuContextHelp: MpvGpuContextProbe = (target) => {
  const result = spawnSync(target.bin, ["--no-config", "--gpu-context=help"], {
    encoding: "utf8",
    env: buildExternalMpvTargetEnv(target, { env: process.env }),
    timeout: 10_000,
    windowsHide: true,
  });
  const error = result.error
    ? result.error.message
    : result.status === 0 ? null : `exit ${String(result.status ?? result.signal)}`;
  return { output: `${result.stdout ?? ""}`, error };
};

const mpvWaylandByBin = new Map<string, boolean>();

/**
 * Whether `target` can open a native Wayland window: its `--gpu-context=help`
 * lists a `wayland*` context. The bundled mpv lists only `x11egl` (media-deps
 * builds -Dwayland=disabled); a distro or Flatpak mpv set through
 * SF_MPV_SYSTEM_BIN usually lists `wayland` and `waylandvk`. Asked once per
 * binary per app session (about 1 s on the first run, 80-100 ms after),
 * and only on a Wayland-only Linux session.
 * A probe that fails counts as no Wayland.
 */
export const mpvHasWayland = (target: ResolvedExternalMpvTarget, probe: MpvGpuContextProbe = runMpvGpuContextHelp): boolean => {
  const cached = mpvWaylandByBin.get(target.bin);
  if (cached !== undefined) return cached;
  if (target.kind === "fallback") return false;
  const startedAt = Date.now();
  const { output, error } = probe(target);
  const contexts = parseMpvGpuContexts(output);
  const hasWayland = error === null && contexts.some((name) => name.startsWith("wayland"));
  console.info(
    `[mpv-wayland-probe] bin=${target.bin} kind=${target.kind} contexts=${contexts.join(",") || "(none)"} error=${error ?? "none"} hasWayland=${hasWayland} ms=${Date.now() - startedAt}`,
  );
  mpvWaylandByBin.set(target.bin, hasWayland);
  return hasWayland;
};

/** Test seam: forget every cached {@link mpvHasWayland} answer. */
export const resetMpvWaylandProbeCache = () => mpvWaylandByBin.clear();

/**
 * The platform's mpv window plan for the mpv that will run (`target`, default
 * the resolved one), with the Wayland question answered by probing it.
 * `noWindow` set = no mpv window can open in this session: report it, do not launch.
 */
export const resolveExternalMpvWindow = (options: {
  appId: string;
  target?: ResolvedExternalMpvTarget;
  env?: NodeJS.ProcessEnv;
  probe?: MpvGpuContextProbe;
}): MpvWindow =>
  getDesktopPlatform().shell.mpvWindow({
    appId: options.appId,
    env: options.env,
    mpvHasWayland: () => mpvHasWayland(options.target ?? resolveExternalMpvTarget({ env: options.env }), options.probe),
  });

// 1x1 PNG: the smallest input that makes mpv set up its OSD (and fonts).
const FONT_WARMUP_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export type MpvFontCacheWarmupPlan = { bin: string; args: string[]; env: NodeJS.ProcessEnv };

/**
 * Headless run of the bundled mpv that builds ITS fontconfig cache, meant to
 * run at app start, at low priority, off the play path.
 *
 * The bundle carries fontconfig 2.13 (cache-7), which cannot read a newer
 * host's caches (2.18: cache-11). Its first OSD setup therefore scanned
 * every host font before the first frame: 1.8 s idle, 17 s under load, a
 * black window meanwhile (#25 P5/B3, @bugfix mpv-bundle-fontconfig-cold-scan).
 * The scan writes cache-7 files next to the host's, so after this run a
 * launch sets up fonts in milliseconds, with the host's full font set (CJK,
 * Cyrillic, ... subtitles keep their glyphs). Null for non-bundle targets:
 * their fontconfig matches the host's caches.
 */
export const planMpvBundleFontCacheWarmup = (
  target: ResolvedExternalMpvTarget,
  base: { env: NodeJS.ProcessEnv; dataDir: string },
): MpvFontCacheWarmupPlan | null => {
  if (target.kind !== "bundle") return null;
  const image = join(base.dataDir, "sf-font-warmup.png");
  if (!existsSync(image)) {
    mkdirSync(base.dataDir, { recursive: true });
    writeFileSync(image, FONT_WARMUP_PNG);
  }
  return {
    bin: target.bin,
    args: ["--no-config", "--vo=null", "--ao=null", "--frames=1", "--really-quiet", image],
    env: buildExternalMpvTargetEnv(target, base),
  };
};

/**
 * P10 (#25): matches `HLS_VIDEO_SEEK_LEAD_SECONDS` in the desktop
 * playbackServer, which announces every HLS video segment boundary this much
 * early so FFmpeg's HLS demuxer (<= n9.0.2) stops discarding the opening
 * keyframe of a seek's target segment (seeks into a segment's first GOP
 * used to land one GOP late, e.g. chapter 180 -> 182.021). Starting the hr-seek
 * demuxer read this much before the target puts targets inside that lead
 * window back into the previous segment, so hr-seek lands exactly everywhere.
 * Costs at most one extra GOP decode on non-HLS sources.
 */
export const MPV_HR_SEEK_DEMUXER_OFFSET_SECONDS = 0.25;

/**
 * The stream cache's readahead target (`--cache-secs`):
 * SF_MPV_STREAM_CACHE_SECS, default 16; 0 disables the cache. The desktop
 * main process restores it after a first-GOP resume's shorter prefill.
 */
export const resolveMpvStreamCacheSecs = (): number => {
  const raw = Number(process.env.SF_MPV_STREAM_CACHE_SECS ?? "16");
  return Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 16;
};

/**
 * The readahead target during a gateway high-traffic period (STOR-BW-01):
 * never above the normal target, never above the gateway's
 * `playbackBufferSeconds`, and at least 1 s while a cache exists. `null` /
 * `undefined` = traffic is normal, the target is unchanged; a disabled cache
 * (0) stays disabled.
 */
export const capMpvStreamCacheSecs = (normalSecs: number, playbackBufferSeconds: number | null | undefined): number => {
  if (normalSecs <= 0 || playbackBufferSeconds === null || playbackBufferSeconds === undefined) return normalSecs;
  if (!Number.isFinite(playbackBufferSeconds)) return normalSecs;
  return Math.min(normalSecs, Math.max(1, Math.floor(playbackBufferSeconds)));
};

/**
 * Resume launches below this many seconds (segment 0's first GOP) prefill
 * this many seconds from 0:00. Mirrors @space/mpv-protocol
 * MPV_RESUME_PREFILL_WINDOW_SECONDS (a desktop test keeps them in lockstep).
 */
const RESUME_PREFILL_WINDOW_SECONDS = 8;

/** `--mute=yes --ao=null`: what an SF_SILENT launch adds, so no mpv stream ever reaches the sound server. */
export const SILENT_MPV_ARGS = ["--mute=yes", "--ao=null"] as const;

/** SF_SILENT=1 (any value but "0"/"false"/"no"): an agent's lane run or a test launch, never a developer's own run. */
export const isSilentMpvEnv = (env: NodeJS.ProcessEnv): boolean => {
  const raw = env.SF_SILENT?.trim().toLowerCase();
  return Boolean(raw) && raw !== "0" && raw !== "false" && raw !== "no";
};

export const buildExternalMpvArgs = (options: ExternalMpvLaunchOptions) => {
  const args: string[] = [];
  // mpv's recommended hardware decoding (#25): the whitelisted hwdecs (nvdec,
  // vaapi, d3d11va, and their copy-back forms for a CPU vo), software decode
  // when none of them takes the codec. SF_MPV_EXTERNAL_HWDEC=no turns it off.
  const hwdec = options.hwdec ?? "auto-safe";
  const appId = options.appId ?? "spacebadger";
  const window = resolveExternalMpvWindow({ appId, target: options.target });
  const vo = options.vo ?? window.defaultVo;

  args.push("--force-window=yes", "--keep-open=yes", `--vo=${vo}`, `--hwdec=${hwdec}`, ...window.args);
  // MPV-AUDIO-02: when no sound output can be opened (Windows default device gone or held exclusively, sound server
  // down), mpv drops the audio track and plays the video silently with nothing to say why. On its null output instead
  // the track stays on, the app sees `current-ao=null`, shows the notice, and `ao-reload` reopens the real output.
  args.push("--audio-fallback-to-null=yes");

  if (!options.disableDefaults) {
    const cacheSecs = capMpvStreamCacheSecs(resolveMpvStreamCacheSecs(), options.playbackBufferSeconds);
    const cacheMaxBytesRaw = Number(process.env.SF_MPV_STREAM_CACHE_MAX_BYTES ?? `${96 * 1024 * 1024}`);
    const cacheMaxBytes = Number.isFinite(cacheMaxBytesRaw)
      ? Math.max(0, Math.floor(cacheMaxBytesRaw))
      : 96 * 1024 * 1024;
    const cacheBackBytesRaw = Number(process.env.SF_MPV_STREAM_CACHE_BACK_BYTES ?? `${16 * 1024 * 1024}`);
    const cacheBackBytes = Number.isFinite(cacheBackBytesRaw)
      ? Math.max(0, Math.floor(cacheBackBytesRaw))
      : 16 * 1024 * 1024;
    // A resume into segment 0's first GOP is the only launch that prefills
    // (see the cache-wait comment below), and only the window.
    const firstGopPrefill = cacheSecs > 0 && Boolean(options.startTime && options.startTime < RESUME_PREFILL_WINDOW_SECONDS);

    args.push(
      "--no-ytdl",
      cacheSecs > 0 ? "--cache=yes" : "--cache=no",
      ...(cacheSecs > 0
        ? [`--cache-secs=${firstGopPrefill ? Math.min(RESUME_PREFILL_WINDOW_SECONDS, cacheSecs) : cacheSecs}`]
        : []),
      ...(cacheMaxBytes > 0 ? [`--demuxer-max-bytes=${cacheMaxBytes}`] : []),
      ...(cacheBackBytes > 0 ? [`--demuxer-max-back-bytes=${cacheBackBytes}`] : []),
      // No prefill before the first frame: playback starts as soon as the
      // stream is playable and the cache fills to its --cache-secs readahead
      // target in the background (Chris, 2026-10-09, #25 playable-start).
      // `--demuxer-cache-wait=yes` used to hold every start until 16 s were
      // cached; on a resume mpv runs it "before the initial seek triggered
      // with --start" (mpv manual), so it read 16 s from 0:00 and the seek
      // threw them away (@bugfix ttff-resume-cache-wait-prefills-from-zero).
      // Throttled real-mpv run (2500 kbps stream, 2.8 Mbps link): first frame
      // 12.7 s → 0.47 s from 0:00 and 13.0 s → 0.73 s on a resume, with the
      // same stalls; `--cache-pause-initial` only added a ~1 s stall, so no
      // initial threshold either. The wait was added against the "loops 4-10
      // times on the first 3 s" start (@bugfix
      // mpv-launch-loop-from-demuxer-cache-not-prefilled); the causes found
      // since are fixed at the source (prewarm, http_multiple=0 below, the
      // playbackServer's prefetch), and the throttled run played straight
      // through without one.
      //
      // A resume INSIDE segment 0's first GOP keeps a short prefill:
      // serving the --start seek from the seekable cache is what makes it
      // land. Uncached, FFmpeg's HLS demuxer snaps a seek into segment 0 to
      // its start and drops the first keyframe (negative DTS from the
      // B-frame delay), so a resume at 1 s played from ~4 s, the next
      // keyframe. --cache-secs above caps that prefill to the window; the
      // desktop main process restores the readahead target on the first
      // playback-restart. @bugfix resume-first-gop-lands-one-gop-late
      // Every loadfile (backdrop handoff, alive-mpv reload, ABR) carries the
      // same split per file (@space/mpv-protocol buildLoadfileCommand).
      ...(firstGopPrefill ? ["--demuxer-cache-wait=yes"] : []),
      "--osc=no",
      // MPV-OSC-05: mpv's own OSD text (warnings, osd_message) and text
      // subtitles keep one size whatever the window size, like our controls
      // and menus; sf.lua multiplies both by the display's HiDPI scale.
      "--osd-scale-by-window=no",
      "--sub-scale-by-window=no",
      // http_multiple=0: FFmpeg's HLS demuxer (auto → on for HTTP/1.1)
      // otherwise opens the NEXT segment synchronously before it returns the
      // first byte of the current one (libavformat/hls.c read_data →
      // open_input(input_next)). The desktop playbackServer answers only once
      // the whole object is fetched + decrypted, so every rendition probe at
      // open and the first read after a seek blocked on a segment mpv did not
      // need yet: 57 % of each cold HLS open on the issue #25 low-end run
      // (median 0.57 s of 1.0 s). The playbackServer prefetches next keys
      // itself, so the second connection bought nothing.
      // @bugfix ttff-hls-http-multiple-blocks-on-next-segment
      "--demuxer-lavf-o=live_start_index=0,prefer_x_start=1,http_multiple=0",
      "--load-scripts=no",
      // mpv's built-in scripts: each is a Lua state + thread on every launch.
      // Only `console` is used (mp.input behind sf-select.lua's track menus);
      // --no-ytdl above drops ytdl_hook. @bugfix mpv-unused-builtin-scripts-loaded
      "--load-stats-overlay=no",
      "--load-select=no",
      "--load-positioning=no",
      "--load-commands=no",
      "--load-auto-profiles=no",
      "--load-context-menu=no",
      "--auto-window-resize=no",
      "--keepaspect-window=no",
      "--autofit=0",
      "--autofit-larger=0",
      "--autofit-smaller=0",
      "--border=no",
      "--input-default-bindings=no",
      "--no-config"
    );
    args.push(`--hr-seek-demuxer-offset=${MPV_HR_SEEK_DEMUXER_OFFSET_SECONDS}`);
    const windowScaleRaw = Number(process.env.SF_MPV_WINDOW_SCALE ?? "0.7");
    const windowScale = Number.isFinite(windowScaleRaw)
      ? Math.min(1, Math.max(0.4, windowScaleRaw))
      : 0.7;
    const geometry =
      process.env.SF_MPV_WINDOW_GEOMETRY?.trim() ??
      `${Math.round(windowScale * 100)}%x${Math.round(windowScale * 100)}%`;
    if (geometry) {
      args.push(`--geometry=${geometry}`);
    }
    const inputConf = resolveMpvInputConf();
    if (inputConf) {
      args.push(`--input-conf=${inputConf}`);
    }
    const oscScript = resolveMpvOscScript();
    const selectScript = resolveMpvOscSelectScript();
    const tog4in1Script = resolveMpvTog4in1Script();
    const tog4in1Fonts = resolveMpvTog4in1FontsDir();
    if (tog4in1Fonts) {
      args.push(`--osd-fonts-dir=${tog4in1Fonts}`);
    }
    if (selectScript) {
      args.push(`--script=${selectScript}`);
    }
    if (tog4in1Script) {
      args.push(`--script=${tog4in1Script}`);
    }
    if (oscScript) {
      args.push(`--script=${oscScript}`);
    }
  }

  if (options.extraArgs?.length) {
    args.push(...options.extraArgs);
  }

  // REL-ENV-36: agents' lane runs and every test launch set SF_SILENT=1.
  // After the extra args so an `--ao` in SF_MPV_EXTERNAL_ARGS cannot bring the sound back (mpv: last one wins).
  if (isSilentMpvEnv(process.env)) {
    args.push(...SILENT_MPV_ARGS);
  }

  const title = options.title ?? "SpaceBadger";
  args.push(`--title=${title}`);

  if (options.logFile) {
    args.push(`--log-file=${options.logFile}`);
  }

  if (options.paused) {
    args.push("--pause");
  }

  if (options.startTime && options.startTime > 0) {
    args.push(`--start=${options.startTime}`);
  }

  if (options.url) {
    if (options.audioUrl) {
      args.push(`--audio-file=${options.audioUrl}`);
    }
    args.push(options.url);
  } else {
    // No file: stay up with the forced window until the caller loads one.
    args.push("--idle=yes");
  }
  return args;
};
