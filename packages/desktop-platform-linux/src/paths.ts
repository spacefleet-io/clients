import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Env, PathLayer, PathLog } from "@space/desktop-platform-contract";
import { restrictDirToOwnerPosix, restrictFileToOwnerPosix } from "@space/desktop-platform-contract";
import {
  copyTree,
  inspectLegacyDir,
  OWNER_ONLY,
  processAlive,
  readPid,
  runUnderMigrationLock,
  shredFileSync,
  type MigrationLockSeams,
} from "./legacyMigration";

/**
 * Where the runtime data dir lived before it moved under XDG_DATA_HOME. `/tmp`
 * is a tmpfs on most distros (Arch, Fedora, ...), so everything there - keys,
 * job queues, library databases - was wiped at every reboot.
 */
export const LEGACY_RUNTIME_DATA_DIR = "/tmp/spacefleet-runtime";

/**
 * Files the guardian and the runtime write for their own bookkeeping (log, pid,
 * ref count, spawn lock). They are not user data: a dir holding only these is
 * still "empty" for the migration, and the legacy copies are not carried over
 * (they describe processes of the previous boot).
 */
const BOOKKEEPING: Record<string, true> = { "runtime.log": true, "runtime.pid": true, "runtime.refs": true, "runtime.spawn.lock": true };

/** The runtime's key file of builds before RT-SEC-05: plaintext keys, shredded in the legacy dir after the copy. */
const LEGACY_KEYS_FILE = "runtime_keys.json";

const consoleLog: PathLog = (level, message, meta) => console[level](`[runtime-data-dir] ${message}`, meta ?? "");

const holdsNoData = (dir: string): boolean => !existsSync(dir) || readdirSync(dir).every((name) => Object.hasOwn(BOOKKEEPING, name));

export type LegacyMigrationSeams = MigrationLockSeams & {
  /** Directory to migrate from (default {@link LEGACY_RUNTIME_DATA_DIR}). */
  legacyDir?: string;
  /** uid the legacy dir must belong to (default this process's). */
  uid?: number;
  /** Runs once the copy into staging is done, before the staging dir replaces the target (tests). */
  beforeFinalize?: () => void;
};

/** Put the bookkeeping files moved into `staging` back into `target` (failed finalize). */
const restoreBookkeeping = (staging: string, target: string) => {
  if (!existsSync(staging)) return;
  mkdirSync(target, { recursive: true, mode: OWNER_ONLY });
  for (const name of Object.keys(BOOKKEEPING)) {
    const from = join(staging, name);
    if (existsSync(from) && !existsSync(join(target, name))) renameSync(from, join(target, name));
  }
};

/**
 * One-time carry-over of the legacy `/tmp` runtime data dir into `target`.
 *
 * Runs only while `target` holds no data, and only from a real directory (not
 * a symlink) owned by this user: `/tmp` is shared, so another user's
 * `/tmp/spacefleet-runtime` must never be trusted. Skipped while a runtime of
 * the previous build still uses it (live pid in its `runtime.pid`).
 *
 * One process migrates at a time (two desktop apps may start together): it
 * holds `.<target>.migrate.lock` next to `target` from before the copy until
 * after the rename; the others wait for it (bounded by `waitMs`), then find the
 * data in place. Crash safety: the data is copied into a staging dir next to
 * `target` and the staging dir is renamed onto `target` in one step, so
 * `target` is either untouched or complete; the legacy dir is left in place
 * (the OS clears it at reboot), so an interrupted run loses nothing and the
 * next start retries. Data that appears in `target` meanwhile (a process that
 * stopped waiting) wins: the migration is then abandoned, never merged.
 */
const migrateLegacyRuntimeDataDir = (target: string, log: PathLog, seams: LegacyMigrationSeams): void => {
  const legacyDir = seams.legacyDir ?? LEGACY_RUNTIME_DATA_DIR;
  const uid = seams.uid ?? process.getuid?.() ?? -1;
  const isAlive = seams.isAlive ?? processAlive;
  const meta = { from: legacyDir, to: target };
  const parent = dirname(target);
  const lock = join(parent, `.${basename(target)}.migrate.lock`);
  const staging = join(parent, `.${basename(target)}.migrating`);
  let entries: string[] = [];
  const shouldRun = (): boolean => {
    if (!holdsNoData(target)) return false;
    if (!inspectLegacyDir(legacyDir, uid, "runtime data dir", log, meta)) return false;
    const legacyPid = readPid(join(legacyDir, "runtime.pid"));
    if (legacyPid !== null && isAlive(legacyPid)) {
      log("warn", "a runtime still uses the legacy runtime data dir; migrating it on a later start", { ...meta, pid: legacyPid });
      return false;
    }
    entries = readdirSync(legacyDir).filter((name) => !Object.hasOwn(BOOKKEEPING, name));
    return entries.length > 0;
  };
  runUnderMigrationLock({ lock, what: "runtime data dir", log, meta, seams }, shouldRun, () =>
    copyAndSwap({ legacyDir, target, staging, entries, log, meta, beforeFinalize: seams.beforeFinalize }),
  );
};

/** The migration proper, run while holding the lock. */
const copyAndSwap = ({
  legacyDir,
  target,
  staging,
  entries,
  log,
  meta,
  beforeFinalize,
}: {
  legacyDir: string;
  target: string;
  staging: string;
  entries: string[];
  log: PathLog;
  meta: { from: string; to: string };
  beforeFinalize?: () => void;
}) => {
  // The previous holder may have finished just before we took the lock.
  if (!holdsNoData(target)) return;
  try {
    // We hold the lock: a staging dir left here is from an interrupted run.
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { mode: OWNER_ONLY });
    for (const name of entries) copyTree(join(legacyDir, name), join(staging, name));
    beforeFinalize?.();
    if (existsSync(target)) {
      const present = readdirSync(target);
      if (!present.every((name) => Object.hasOwn(BOOKKEEPING, name))) {
        rmSync(staging, { recursive: true, force: true });
        log("warn", "the runtime data dir received data during the migration; keeping it and not migrating the legacy dir", {
          ...meta,
          present,
        });
        return;
      }
      // Only bookkeeping lives there: keep it, e.g. the log the guardian already opened.
      for (const name of present) renameSync(join(target, name), join(staging, name));
      rmdirSync(target);
    }
    renameSync(staging, target);
  } catch (error) {
    try {
      restoreBookkeeping(staging, target);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    throw error;
  }
  // The copy of the old plaintext key file is now in `target`, where the runtime reads it once and
  // shreds it (RT-SEC-05); the original must not stay behind in the shared /tmp.
  if (entries.includes(LEGACY_KEYS_FILE)) {
    try {
      shredFileSync(join(legacyDir, LEGACY_KEYS_FILE));
    } catch (error) {
      log("warn", "could not delete the plaintext key file left in the legacy runtime data dir", {
        ...meta,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  log("info", "migrated the legacy runtime data dir (copied; the original is left for the OS to clear at reboot, minus the key file)", { ...meta, entries });
};

/** {@link PathLayer.prepareRuntimeDataDir} with test seams for the legacy migration. */
export const prepareLinuxRuntimeDataDir = (
  { env = process.env, log = consoleLog }: { env?: Env; log?: PathLog } = {},
  seams: LegacyMigrationSeams = {},
): string => {
  const dir = linuxPaths.runtimeDataDir(env);
  if (env.SPACEFLEET_RUNTIME_DATA_DIR?.trim()) {
    mkdirSync(dir, { recursive: true, mode: OWNER_ONLY });
    return dir;
  }
  try {
    migrateLegacyRuntimeDataDir(dir, log, seams);
  } catch (error) {
    // A failed carry-over never stops the start: the legacy dir stays, and the next start retries.
    log("error", "migrating the legacy runtime data dir failed; it is left in place and retried at the next start", {
      from: seams.legacyDir ?? LEGACY_RUNTIME_DATA_DIR,
      to: dir,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  mkdirSync(dir, { recursive: true, mode: OWNER_ONLY });
  // A migrated dir keeps the legacy dir's mode; the default dir is ours, so pin it.
  chmodSync(dir, OWNER_ONLY);
  return dir;
};

export const linuxPaths: PathLayer = {
  runtimeDataDir: (env = process.env) =>
    env.SPACEFLEET_RUNTIME_DATA_DIR?.trim() || join(linuxPaths.userDataBase(env), "SpaceFleet", "runtime"),
  prepareRuntimeDataDir: (options) => prepareLinuxRuntimeDataDir(options),
  restrictFileToOwner: restrictFileToOwnerPosix,
  restrictDirToOwner: restrictDirToOwnerPosix,
  /** XDG_DATA_HOME when absolute (the XDG spec says to ignore a relative one), else `~/.local/share`. */
  userDataBase: (env = process.env) => {
    const xdg = env.XDG_DATA_HOME?.trim();
    return xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "share");
  },
  // Existing installs keep their directory.
  appUserDataDir: ({ appData, legacyDir }) => join(appData, ...legacyDir),
};
