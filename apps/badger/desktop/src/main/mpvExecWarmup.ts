// First exec of the bundled mpv, off the main thread (#928).
//
// Windows Defender scans a freshly installed (or freshly updated) mpv.exe on its
// first exec, and CreateProcess blocks its caller for the whole scan: 2.4-3.5 s on
// a 2-core Celeron Windows test machine, against ~35 ms for every exec after it. A plain
// read of the file does not take the scan; an exec does. libuv's spawn is a
// synchronous CreateProcess, so the first play froze the Electron main thread
// (and with it the playback proxy and every IPC) for those seconds, right on the
// click -> first frame path.
//
// `mpv --version` run once from a worker thread takes that first exec: the scan
// blocks the worker, not the main thread, and it starts as soon as playback is
// likely (the details dialog opens, a stream starts loading), so it overlaps the
// pre-launch loads. The launch awaits it instead of paying the scan inside its
// own spawn. Elsewhere it is a ~35 ms process, once per app session.

import { Worker } from "node:worker_threads";
import { buildExternalMpvTargetEnv, type ResolvedExternalMpvTarget } from "@space/mpv";
import { scopeLogger } from "./logger";

const logger = scopeLogger("mpv-exec-warmup");

/** `mpv --version` exits at once; this only bounds a wedged exec (the scan itself is a few seconds). */
const WARMUP_TIMEOUT_MS = 30_000;

export type MpvExecWarmupPlan = { bin: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number };
export type MpvExecWarmupResult = { ms: number; ok: boolean; error: string | null };

// CommonJS: an eval worker is not an ES module.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { spawnSync } = require("node:child_process");
const startedAt = Date.now();
const result = spawnSync(workerData.bin, workerData.args, {
  env: workerData.env,
  stdio: "ignore",
  windowsHide: true,
  timeout: workerData.timeoutMs,
});
parentPort.postMessage({
  ms: Date.now() - startedAt,
  ok: !result.error && result.status === 0,
  error: result.error ? String(result.error.message) : result.status === 0 ? null : "exit " + String(result.status ?? result.signal),
});
`;

const runInWorker = (plan: MpvExecWarmupPlan): Promise<MpvExecWarmupResult> =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const settle = (result: MpvExecWarmupResult) => {
      resolve(result);
      void worker.terminate();
    };
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: plan });
    worker.once("message", (result: MpvExecWarmupResult) => settle(result));
    worker.once("error", (error) => settle({ ms: Date.now() - startedAt, ok: false, error: error.message }));
    worker.once("exit", (code) => settle({ ms: Date.now() - startedAt, ok: false, error: `worker exited ${code}` }));
  });

export const planMpvExecWarmup = (target: ResolvedExternalMpvTarget): MpvExecWarmupPlan | null =>
  // "fallback" = no binary: the launch reports that itself.
  target.kind === "fallback"
    ? null
    : {
      bin: target.bin,
      args: ["--version"],
      env: buildExternalMpvTargetEnv(target, { env: process.env }),
      timeoutMs: WARMUP_TIMEOUT_MS,
    };

export type MpvExecWarmup = {
  /**
   * Runs the first exec of `target` once per app session. Concurrent and later calls share that run;
   * resolves when it is over (null: nothing to run).
   */
  warm: (target: ResolvedExternalMpvTarget) => Promise<MpvExecWarmupResult | null>;
};

export const createMpvExecWarmup = (
  run: (plan: MpvExecWarmupPlan) => Promise<MpvExecWarmupResult> = runInWorker,
): MpvExecWarmup => {
  const runs = new Map<string, Promise<MpvExecWarmupResult | null>>();
  return {
    warm: (target) => {
      const known = runs.get(target.bin);
      if (known) return known;
      const plan = planMpvExecWarmup(target);
      // A failed run is not retried: the launch's own spawn reports what is wrong with the binary.
      const started = plan
        ? run(plan).then((result) => {
          logger[result.ok ? "info" : "warn"]({ bin: plan.bin, ...result }, "mpv first exec done");
          return result;
        })
        : Promise.resolve(null);
      runs.set(target.bin, started);
      return started;
    },
  };
};
