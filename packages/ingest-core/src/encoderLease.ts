import { promises as fs, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getDesktopPlatform } from "@space/desktop-platform";

/**
 * Encoder lease: which ffmpeg process (and which runtime) is writing a DASH
 * outputs dir.
 *
 * Why (P26, ultimate confirm run 2026-10-07, shard-2 job ec1d9262): the
 * runtime was SIGKILLed right after spawning a 360p DASH encode. Its ffmpeg
 * child survived the kill (children are not killed with a SIGKILLed parent)
 * and kept writing `seg-*.m4s.tmp` → `seg-*.m4s` renames into the outputs
 * dir. The restarted runtime re-ran the job into the SAME dir, so two muxers
 * raced on the same segment names and the new one died with
 * `failed to rename seg-00001.m4s.tmp … No such file`. Nothing removed the
 * dir: the orphan renamed the temp file out from under it.
 *
 * Before a DASH encode starts, `reclaimOrphanEncoder` reads the lease left in
 * the outputs dir. If it belongs to a DEAD runtime and names an encoder that
 * is still ALIVE and is verifiably the same encode (its command line contains
 * the lease's manifest path, which embeds the job id), the orphan is killed
 * and the dir is wiped (logged with reason `orphan-encoder-reaped`). Anything
 * it cannot verify is left alone and logged, never killed on a guess.
 */
export const ENCODER_LEASE_FILE = ".encoder-lease.json";

export type EncoderLease = {
  /** The ffmpeg process writing the dir. */
  pid: number;
  /** The runtime process that spawned it. */
  ownerPid: number;
  mpdPath: string;
  startedAt: string;
};

export type EncoderLeaseDeps = {
  ownPid: number;
  readText: (path: string) => string | null;
  writeText: (path: string, text: string) => void;
  remove: (path: string) => void;
  isAlive: (pid: number) => boolean;
  /** Full command line of `pid`, or `null` when it cannot be read on this platform. */
  readCommandLine: (pid: number) => Promise<string | null>;
  kill: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
  /** Wipe and recreate `dir`. */
  resetDir: (dir: string) => Promise<void>;
  info: (message: string, data: Record<string, unknown>) => void;
  warn: (message: string, data: Record<string, unknown>) => void;
};

export type OrphanEncoderOutcome =
  | "no-lease"
  | "invalid-lease"
  | "own-lease"
  | "owner-alive"
  | "encoder-gone"
  | "identity-mismatch"
  | "unsupported"
  | "reaped";

const REAP_EXIT_WAIT_MS = 3000;
const REAP_POLL_MS = 50;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

const defaultDeps = (): EncoderLeaseDeps => ({
  ownPid: process.pid,
  readText: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  writeText: (path, text) => writeFileSync(path, text),
  remove: (path) => rmSync(path, { force: true }),
  isAlive,
  readCommandLine: (pid) => getDesktopPlatform().processes.readCommandLine(pid),
  kill: (pid) => process.kill(pid, "SIGKILL"),
  sleep: (ms) => sleep(ms),
  resetDir: async (dir) => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
  },
  info: (message, data) => console.info(message, data),
  warn: (message, data) => console.warn(message, data),
});

const resolveDeps = (overrides: Partial<EncoderLeaseDeps>): EncoderLeaseDeps => ({
  ...defaultDeps(),
  ...overrides,
});

const parseLease = (raw: string): EncoderLease | null => {
  try {
    const value = JSON.parse(raw) as Partial<EncoderLease>;
    if (
      typeof value.pid === "number" &&
      typeof value.ownerPid === "number" &&
      typeof value.mpdPath === "string" &&
      typeof value.startedAt === "string"
    ) {
      return value as EncoderLease;
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Make `outputDir` safe to encode into: kill a verified orphan encoder from a
 * dead runtime that is still writing it, then wipe the dir. Never throws.
 */
export const reclaimOrphanEncoder = async (
  outputDir: string,
  overrides: Partial<EncoderLeaseDeps> = {}
): Promise<OrphanEncoderOutcome> => {
  const deps = resolveDeps(overrides);
  const leasePath = joinPath(outputDir, ENCODER_LEASE_FILE);
  const raw = deps.readText(leasePath);
  if (raw === null) return "no-lease";
  const lease = parseLease(raw);
  if (!lease) {
    deps.warn("[mediaProcessor] discarding unreadable encoder lease", { outputDir, raw: raw.slice(0, 200) });
    deps.remove(leasePath);
    return "invalid-lease";
  }
  const context = { outputDir, ...lease, ownPid: deps.ownPid };
  if (lease.ownerPid === deps.ownPid) {
    // Leases are released when the encode exits, so a live one of ours means
    // a second encode into the same dir from this very runtime. Not an orphan.
    deps.warn("[mediaProcessor] encoder lease already held by this runtime", context);
    return "own-lease";
  }
  if (deps.isAlive(lease.ownerPid)) {
    deps.warn("[mediaProcessor] encoder lease held by another live process; not touching it", context);
    return "owner-alive";
  }
  if (!deps.isAlive(lease.pid)) {
    deps.info("[mediaProcessor] stale encoder lease (encoder exited)", context);
    deps.remove(leasePath);
    return "encoder-gone";
  }
  const commandLine = await deps.readCommandLine(lease.pid);
  if (commandLine === null) {
    deps.warn("[mediaProcessor] UNSUPPORTED: cannot verify orphan encoder identity; not killing it", context);
    return "unsupported";
  }
  if (!commandLine.includes(lease.mpdPath)) {
    // The pid was reused by an unrelated process.
    deps.info("[mediaProcessor] encoder lease pid reused by another process", {
      ...context,
      commandLine: commandLine.slice(0, 300),
    });
    deps.remove(leasePath);
    return "identity-mismatch";
  }
  deps.kill(lease.pid);
  let exited = !deps.isAlive(lease.pid);
  for (let waited = 0; !exited && waited < REAP_EXIT_WAIT_MS; waited += REAP_POLL_MS) {
    await deps.sleep(REAP_POLL_MS);
    exited = !deps.isAlive(lease.pid);
  }
  deps.warn("[mediaProcessor] reaped orphan encoder", { ...context, exited });
  deps.warn("[mediaProcessor] removing outputs dir", { reason: "orphan-encoder-reaped", outputDir, pid: lease.pid });
  await deps.resetDir(outputDir);
  return "reaped";
};

/** Record that `pid` (spawned by this runtime) is writing `outputDir`. Synchronous so the window between spawn and lease is as small as possible. Never throws. */
export const writeEncoderLease = (
  outputDir: string,
  pid: number,
  mpdPath: string,
  overrides: Partial<EncoderLeaseDeps> = {}
): void => {
  const deps = resolveDeps(overrides);
  const lease: EncoderLease = { pid, ownerPid: deps.ownPid, mpdPath, startedAt: new Date().toISOString() };
  try {
    deps.writeText(joinPath(outputDir, ENCODER_LEASE_FILE), JSON.stringify(lease));
  } catch (err) {
    deps.warn("[mediaProcessor] could not write encoder lease", {
      outputDir,
      pid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

/** Drop the lease if it still names `pid` (a newer encode's lease is left alone). Never throws. */
export const releaseEncoderLease = (
  outputDir: string,
  pid: number,
  overrides: Partial<EncoderLeaseDeps> = {}
): void => {
  const deps = resolveDeps(overrides);
  const leasePath = joinPath(outputDir, ENCODER_LEASE_FILE);
  const raw = deps.readText(leasePath);
  if (raw === null || parseLease(raw)?.pid !== pid) return;
  try {
    deps.remove(leasePath);
  } catch (err) {
    deps.warn("[mediaProcessor] could not release encoder lease", {
      outputDir,
      pid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
