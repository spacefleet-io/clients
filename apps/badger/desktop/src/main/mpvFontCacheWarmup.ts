// Bundled-mpv font cache warm-up at app start (#25 P5/B3).
//
// The Linux bundle's fontconfig cannot read the host's newer font caches, so
// without this the first play scanned every system font before mpv's first
// frame (black window: 1.8 s idle, 17 s under load). Running the bundle once,
// headless and at the lowest priority, right after startup builds its cache
// off the play path; later launches set up fonts in milliseconds. Warm caches
// make this run ~0.2 s. Non-bundle targets skip it.

import { spawn } from "node:child_process";
import { setPriority } from "node:os";
import { getDesktopPlatform } from "@space/desktop-platform";
import { buildExternalMpvEnv, planMpvBundleFontCacheWarmup, type ResolvedExternalMpvTarget } from "@space/mpv";
import { scopeLogger } from "./logger";

const logger = scopeLogger("mpv-font-cache-warmup");

const LOWEST_PRIORITY = 19;
/** A wedged warm-up must not linger: a cold scan of a big font set is ~20 s under load. */
const WARMUP_KILL_AFTER_MS = 120_000;

export type MpvFontCacheWarmupDeps = {
  spawnImpl?: typeof spawn;
  setPriorityImpl?: (pid: number, priority: number) => void;
  appId?: string;
};

export const warmMpvBundleFontCache = (target: ResolvedExternalMpvTarget, deps: MpvFontCacheWarmupDeps = {}): void => {
  if (target.kind !== "bundle") {
    logger.debug({ kind: target.kind }, "font cache warm-up skipped (not the bundle)");
    return;
  }
  const { env, dataDir } = buildExternalMpvEnv({ appId: deps.appId ?? "spacebadger" });
  const plan = planMpvBundleFontCacheWarmup(target, { env, dataDir });
  if (!plan) return;
  const startedAt = Date.now();
  try {
    const child = (deps.spawnImpl ?? spawn)(plan.bin, plan.args, {
      env: plan.env,
      stdio: "ignore",
      ...getDesktopPlatform().processes.spawnOptions({ detached: false }),
    });
    if (child.pid !== undefined) {
      try {
        (deps.setPriorityImpl ?? setPriority)(child.pid, LOWEST_PRIORITY);
      } catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, "font cache warm-up: could not lower priority");
      }
    }
    const killTimer = setTimeout(() => child.kill("SIGKILL"), WARMUP_KILL_AFTER_MS);
    killTimer.unref?.();
    child.once("error", (error) => {
      clearTimeout(killTimer);
      logger.warn({ bin: plan.bin, error: error.message }, "font cache warm-up failed to start");
    });
    child.once("exit", (code, signal) => {
      clearTimeout(killTimer);
      logger.info({ bin: plan.bin, code, signal, ms: Date.now() - startedAt }, "font cache warm-up done");
    });
    logger.info({ bin: plan.bin, args: plan.args, pid: child.pid ?? null }, "font cache warm-up started");
  } catch (error) {
    logger.warn({ bin: plan.bin, error: error instanceof Error ? error.message : String(error) }, "font cache warm-up failed to start");
  }
};
