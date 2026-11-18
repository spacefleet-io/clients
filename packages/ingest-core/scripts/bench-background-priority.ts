/**
 * Focused benchmark: does a background CPU transcode make playback stutter?
 *
 * Models the reference "common home PC" (4 cores, no GPU encoder, software
 * compositing): run the whole thing pinned to 4 CPUs, force the CPU encoder,
 * play a fixture through real mpv (vo=x11 under Xvfb, software decode) while
 * an add-quality-shaped libx264/libx265 DASH encode runs in the background,
 * and report what the viewer would feel:
 *   - mpv dropped frames (VO drops + decoder drops + mistimed + delayed)
 *   - time to first frame (spawn -> first `time-pos`)
 *   - a UI-responsiveness proxy: a normal-priority process on the same CPUs
 *     asks for a 10 ms timer and we record how late the wake-ups are
 *   - the encode's own throughput (so the cost of yielding is visible)
 *
 * Encode policies compared (all use the PRODUCT arg builder + spawn path:
 * `buildDashVideoArgs` + `createFfmpegTask`):
 *   none     — no background encode (floor)
 *   normal   — niceness 0, no thread caps         (what the issue describes)
 *   before   — niceness 5, no thread caps         (origin/staging behaviour)
 *   after    — product defaults: niceness 10, threads = cores - 2
 *   encode-only variants (`*-only`) run the encode alone, to completion, to
 *   measure how much slower a yielding encode finishes.
 *
 * Usage (pin CPUs yourself; the script reads `availableParallelism()`):
 *   flock -o /tmp/sf-heavy.lock taskset -c 22,23,28,29 \
 *     env -u WAYLAND_DISPLAY bun packages/ingest-core/scripts/bench-background-priority.ts \
 *       --modes none,before,after --repeat 3 --seconds 45 --out /tmp/bench.json
 *
 * Flags: --fixture PATH (encode source)  --play-fixture PATH (what mpv plays; default = --fixture)  --seconds N  --speed X (mpv --speed; 2 emulates a
 * CPU half as fast)  --quality 1080p|720p|2160p  --encode-seconds N (limit of
 * source consumed by the encode-only runs)  --repeat N  --modes a,b,c
 * --out FILE  --single (internal: one run, JSON on the last stdout line)
 */

import { availableParallelism } from "node:os";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createFfmpegTask } from "@space/ffmpeg";
import { buildDashVideoArgs } from "../src/mediaProcessor";
import type { QualityPreset } from "../src/quality";

type Policy = "none" | "normal" | "before" | "after";

const POLICY: Record<Exclude<Policy, "none">, { niceness?: number; threads?: number }> = {
  normal: { niceness: 0, threads: 0 },
  before: { niceness: 5, threads: 0 },
  after: {}, // product defaults
};

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const log = (tag: string, data?: Record<string, unknown>) =>
  console.error(`[bench-bgprio:${tag}]`, data ? JSON.stringify(data) : "");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const percentile = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0;

// ---------------------------------------------------------------------------
// UI responsiveness proxy: separate process, normal priority, same CPU mask.
// ---------------------------------------------------------------------------
const PROBE_SRC = `
const interval = 10; const lags = []; let last = performance.now();
const end = last + Number(process.env.PROBE_MS);
const t = setInterval(() => {
  const now = performance.now(); lags.push(Math.max(0, now - last - interval)); last = now;
  if (now >= end) { clearInterval(t);
    const s = lags.sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] ?? 0;
    console.log(JSON.stringify({ n: s.length, p50: q(50), p95: q(95), p99: q(99), max: s[s.length - 1] ?? 0, over50: s.filter((x) => x > 50).length, over100: s.filter((x) => x > 100).length }));
  }
}, interval);
`;

// ---------------------------------------------------------------------------
// Minimal mpv JSON-IPC client.
// ---------------------------------------------------------------------------
const connectMpv = async (sock: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  let id = 0;
  const pending = new Map<number, (v: unknown) => void>();
  let buf = "";
  for (;;) {
    try {
      const s = await Bun.connect({
        unix: sock,
        socket: {
          data(_s, chunk) {
            buf += Buffer.from(chunk).toString("utf8");
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              try {
                const msg = JSON.parse(line) as { request_id?: number; data?: unknown; error?: string };
                if (msg.request_id != null) pending.get(msg.request_id)?.(msg.error === "success" ? msg.data : null);
              } catch {
                /* event line */
              }
            }
          },
        },
      });
      return {
        get: (prop: string) =>
          new Promise<unknown>((resolve) => {
            const rid = ++id;
            pending.set(rid, resolve);
            s.write(JSON.stringify({ command: ["get_property", prop], request_id: rid }) + "\n");
            setTimeout(() => resolve(null), 1500);
          }),
        quit: () => s.write(JSON.stringify({ command: ["quit"] }) + "\n"),
        close: () => s.end(),
      };
    } catch {
      if (Date.now() > deadline) throw new Error(`mpv ipc ${sock} not up after ${timeoutMs}ms`);
      await sleep(10);
    }
  }
};

const startXvfb = async () => {
  for (let n = 190; n < 230; n++) {
    if (existsSync(`/tmp/.X11-unix/X${n}`) || existsSync(`/tmp/.X${n}-lock`)) continue;
    const proc = Bun.spawn(["Xvfb", `:${n}`, "-screen", "0", "1920x1080x24", "-nolisten", "tcp"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    for (let i = 0; i < 100; i++) {
      if (existsSync(`/tmp/.X11-unix/X${n}`)) return { display: `:${n}`, proc };
      await sleep(50);
    }
    proc.kill();
  }
  throw new Error("no free Xvfb display");
};

interface EncodeHandle {
  done: Promise<{ ok: boolean; wallMs: number; err?: string }>;
  snapshot: () => Record<string, unknown>;
  cancel: () => void;
  wallMs: () => number;
}

const startEncode = (
  policy: Exclude<Policy, "none">,
  fixture: string,
  outDir: string,
  quality: QualityPreset,
  limitSeconds: number | null
): EncodeHandle => {
  mkdirSync(outDir, { recursive: true });
  const args = buildDashVideoArgs({
    inputPath: fixture,
    mpdPath: join(outDir, "manifest.mpd"),
    segmentSeconds: 4,
    encoder: "cpu",
    quality,
    threads: POLICY[policy].threads,
  });
  if (limitSeconds) {
    // bench-only: bound the amount of source consumed
    args.splice(args.indexOf("-f"), 0, "-t", String(limitSeconds));
  }
  log("encode:start", { policy, niceness: POLICY[policy].niceness ?? "product-default", args: args.join(" ") });
  const task = createFfmpegTask(args, {
    niceness: POLICY[policy].niceness,
    progress: {
      enabled: true,
      durationMs: null,
    },
    log: { onLine: () => {} },
  });
  const started = performance.now();
  const done = task.promise.then(
    () => ({ ok: true as const, wallMs: performance.now() - started }),
    (err: unknown) => ({ ok: false as const, wallMs: performance.now() - started, err: String(err) })
  );
  return {
    done,
    snapshot: () => ({ ...(task.stats as Record<string, unknown>) }),
    cancel: () => task.cancel(),
    wallMs: () => performance.now() - started,
  };
};

// ---------------------------------------------------------------------------
// One measured run.
// ---------------------------------------------------------------------------
const runSingle = async (opts: {
  policy: Policy;
  fixture: string;
  playFixture: string;
  seconds: number;
  speed: number;
  quality: QualityPreset;
  encodeOnlySeconds: number;
  encodeOnly: boolean;
}) => {
  const work = mkdtempSync(join(tmpdir(), "sf-bench-bgprio-"));
  const cpus = availableParallelism();
  log("run:start", { ...opts, cpus, work });
  const result: Record<string, unknown> = { policy: opts.policy, encodeOnly: opts.encodeOnly, cpus };

  try {
    if (opts.encodeOnly) {
      const enc = startEncode(opts.policy as Exclude<Policy, "none">, opts.fixture, join(work, "enc"), opts.quality, opts.encodeOnlySeconds);
      const r = await enc.done;
      result.encodeWallS = +(r.wallMs / 1000).toFixed(2);
      result.encodeOk = r.ok;
      result.encodeStats = enc.snapshot();
      return result;
    }

    const xvfb = await startXvfb();
    const display = xvfb.display;
    const probeMs = (opts.seconds + 8) * 1000;
    const probe = Bun.spawn([process.execPath, "-e", PROBE_SRC], {
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, PROBE_MS: String(probeMs) } as Record<string, string>,
    });

    let enc: EncodeHandle | null = null;
    if (opts.policy !== "none") {
      enc = startEncode(opts.policy, opts.fixture, join(work, "enc"), opts.quality, null);
      await sleep(4000); // steady state: the user starts playback while a transcode is already running
    }

    const sock = join(work, "mpv.sock");
    const env = { ...process.env, DISPLAY: display } as Record<string, string>;
    delete env.WAYLAND_DISPLAY;
    const mpvArgs = [
      "mpv",
      "--no-config",
      "--vo=x11",
      "--hwdec=no",
      "--ao=null",
      "--no-terminal",
      "--force-window=yes",
      "--no-osc",
      "--no-input-default-bindings",
      `--speed=${opts.speed}`,
      "--start=30",
      `--input-ipc-server=${sock}`,
      "--msg-level=all=warn",
      opts.playFixture,
    ];
    const spawnedAt = performance.now();
    const mpv = Bun.spawn(mpvArgs, { env, stdout: "ignore", stderr: "pipe" });
    const mpvErr = new Response(mpv.stderr).text();
    const ipc = await connectMpv(sock, 20000);

    // ttff: first non-null time-pos after the window is up
    let ttffMs = -1;
    for (let i = 0; i < 2000; i++) {
      const tp = (await ipc.get("time-pos")) as number | null;
      if (typeof tp === "number") {
        ttffMs = performance.now() - spawnedAt;
        break;
      }
      await sleep(10);
    }
    log("mpv:first-frame", { ttffMs: Math.round(ttffMs) });

    const t0 = performance.now();
    const baseTp = ((await ipc.get("time-pos")) as number) ?? 0;
    await sleep(opts.seconds * 1000);
    log("mpv:window-elapsed");
    const props: Record<string, unknown> = {};
    for (const p of [
      "frame-drop-count",
      "decoder-frame-drop-count",
      "mistimed-frame-count",
      "vo-delayed-frame-count",
      "estimated-frame-number",
      "time-pos",
      "container-fps",
      "avsync",
    ]) {
      props[p] = await ipc.get(p);
    }
    log("mpv:props", props);
    const wallS = (performance.now() - t0) / 1000;
    const playedS = ((props["time-pos"] as number) ?? 0) - baseTp;
    const encSnap = enc?.snapshot();
    const encWall = enc?.wallMs();
    ipc.quit();
    ipc.close();
    enc?.cancel();
    await Promise.race([mpv.exited, sleep(3000)]);
    mpv.kill();
    const mpvStderr = (await Promise.race([mpvErr, sleep(500).then(() => "")])) as string;
    if (enc) await Promise.race([enc.done, sleep(5000)]);
    log("run:teardown-probe");
    const probeOut = await new Response(probe.stdout).text();
    probe.kill();
    xvfb.proc.kill();

    const dropped =
      Number(props["frame-drop-count"] ?? 0) +
      Number(props["decoder-frame-drop-count"] ?? 0) +
      Number(props["mistimed-frame-count"] ?? 0) +
      Number(props["vo-delayed-frame-count"] ?? 0);
    Object.assign(result, {
      ttffMs: Math.round(ttffMs),
      wallS: +wallS.toFixed(2),
      playedS: +playedS.toFixed(2),
      playbackRatio: +(playedS / (wallS * opts.speed)).toFixed(3),
      mpv: props,
      droppedTotal: dropped,
      uiLagMs: JSON.parse(probeOut.trim().split("\n").pop() ?? "{}"),
      encodeSnapshot: encSnap,
      encodeRunSeconds: encWall ? +(encWall / 1000).toFixed(1) : null,
      mpvWarnings: mpvStderr.split("\n").slice(0, 5),
    });
    log("run:done", result);
    return result;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// Driver: interleave policies so host noise hits every policy equally.
// ---------------------------------------------------------------------------
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/** One run's JSON, as emitted by `--single`. Fields are read defensively: a failed run yields `{}`. */
interface RunResult {
  mode: string;
  round: number;
  encodeWallS?: number;
  droppedTotal?: number;
  playbackRatio?: number;
  ttffMs?: number;
  uiLagMs?: { p99?: number; max?: number; over50?: number };
  encodeSnapshot?: { fps?: number; speed?: string };
}

const main = async () => {
  const fixture =
    arg("fixture") ?? join(homedir(), ".cache/sf-ultimate-fixtures", "Ultimate Plain (2020).mkv");
  // Playback fixture defaults to the encode source; override to play something
  // heavier (e.g. the HEVC fixture) than what is being transcoded.
  const playFixture = arg("play-fixture") ?? fixture;
  const seconds = Number(arg("seconds", "45"));
  const speed = Number(arg("speed", "1"));
  const quality = (arg("quality", "1080p") ?? "1080p") as QualityPreset;
  const encodeOnlySeconds = Number(arg("encode-seconds", "120"));

  if (flag("single")) {
    const policy = (arg("policy", "none") ?? "none") as Policy;
    const res = await runSingle({
      policy,
      fixture,
      playFixture,
      seconds,
      speed,
      quality,
      encodeOnlySeconds,
      encodeOnly: flag("encode-only"),
    });
    console.log(JSON.stringify(res));
    return;
  }

  const modes = (arg("modes", "none,before,after") ?? "").split(",").filter(Boolean);
  const repeat = Number(arg("repeat", "3"));
  const runs: RunResult[] = [];
  const selfArgs = [process.execPath, process.argv[1]!];
  for (let r = 0; r < repeat; r++) {
    for (const m of modes) {
      const encodeOnly = m.endsWith("-only");
      const policy = encodeOnly ? m.replace("-only", "") : m;
      log("driver:run", { round: r + 1, mode: m });
      const proc = Bun.spawn(
        [
          ...selfArgs,
          "--single",
          "--policy",
          policy,
          ...(encodeOnly ? ["--encode-only"] : []),
          "--fixture",
          fixture,
          "--play-fixture",
          playFixture,
          "--seconds",
          String(seconds),
          "--speed",
          String(speed),
          "--quality",
          quality,
          "--encode-seconds",
          String(encodeOnlySeconds),
        ],
        { stdout: "pipe", stderr: "inherit", env: process.env as Record<string, string> }
      );
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      try {
        const parsed = JSON.parse(out.trim().split("\n").pop() ?? "{}");
        runs.push({ mode: m, round: r + 1, ...parsed });
      } catch (err) {
        log("driver:parse-failed", { mode: m, out: out.slice(-400), err: String(err) });
      }
    }
  }

  const summary = modes.map((m) => {
    const rs = runs.filter((x) => x.mode === m);
    if (m.endsWith("-only")) {
      return { mode: m, n: rs.length, encodeWallS: rs.map((x) => x.encodeWallS ?? 0), medianEncodeWallS: median(rs.map((x) => x.encodeWallS ?? 0)) };
    }
    return {
      mode: m,
      n: rs.length,
      droppedTotal: rs.map((x) => x.droppedTotal ?? 0),
      medianDropped: median(rs.map((x) => x.droppedTotal ?? 0)),
      playbackRatio: rs.map((x) => x.playbackRatio ?? 0),
      ttffMs: rs.map((x) => x.ttffMs ?? 0),
      medianTtffMs: median(rs.map((x) => x.ttffMs ?? 0)),
      uiLagP99Ms: rs.map((x) => +(x.uiLagMs?.p99 ?? 0).toFixed(1)),
      uiLagMaxMs: rs.map((x) => +(x.uiLagMs?.max ?? 0).toFixed(1)),
      uiLagOver50: rs.map((x) => x.uiLagMs?.over50),
      encodeFpsAtEnd: rs.map((x) => x.encodeSnapshot?.fps ?? null),
      encodeSpeedAtEnd: rs.map((x) => x.encodeSnapshot?.speed ?? null),
    };
  });
  const report = { cpus: availableParallelism(), fixture, seconds, speed, quality, runs, summary };
  console.log(JSON.stringify(summary, null, 2));
  const out = arg("out");
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
};

await main();
