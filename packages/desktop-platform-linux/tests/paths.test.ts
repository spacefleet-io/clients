import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { PathLog } from "@space/desktop-platform-contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linuxPaths, prepareLinuxRuntimeDataDir } from "../src/paths";

const uid = process.getuid?.() ?? -1;
const neverAlive = () => false;

type LogLine = { level: string; message: string; meta?: Record<string, unknown> };

/** A log sink that records lines and echoes them, so a failing case shows what the migration decided. */
const recordingLog = (): { lines: LogLine[]; log: PathLog } => {
  const lines: LogLine[] = [];
  return {
    lines,
    log: (level, message, meta) => {
      lines.push({ level, message, meta });
      console.info(`[linux-paths:migrate] ${level} ${message}`, meta ?? "");
    },
  };
};

const listing = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe("linux paths", () => {
  it("@bugfix @regression-proof defaults the runtime data dir to a persistent per-user dir, never /tmp", () => {
    // Pre-fix the default was /tmp/spacefleet-runtime: a tmpfs on Arch/Fedora, so keys, job queues and
    // the library databases were wiped at every reboot.
    const dir = linuxPaths.runtimeDataDir({});
    console.info("[linux-paths:default] default runtime data dir", { dir });
    expect(dir).toBe(join(homedir(), ".local", "share", "SpaceFleet", "runtime"));
    expect(dir.startsWith("/tmp")).toBe(false);
  });

  it("@bugfix @regression-proof puts the default runtime data dir under an absolute XDG_DATA_HOME", () => {
    expect(linuxPaths.runtimeDataDir({ XDG_DATA_HOME: "  /x/data  " })).toBe("/x/data/SpaceFleet/runtime");
    // The XDG spec says a relative XDG_DATA_HOME is invalid and must be ignored.
    expect(linuxPaths.runtimeDataDir({ XDG_DATA_HOME: "rel/data" })).toBe(join(homedir(), ".local", "share", "SpaceFleet", "runtime"));
  });

  it("honours a trimmed SPACEFLEET_RUNTIME_DATA_DIR and ignores blank values", () => {
    const fallback = "/x/data/SpaceFleet/runtime";
    expect(linuxPaths.runtimeDataDir({ SPACEFLEET_RUNTIME_DATA_DIR: "  /srv/sf  ", XDG_DATA_HOME: "/x/data" })).toBe("/srv/sf");
    expect(linuxPaths.runtimeDataDir({ SPACEFLEET_RUNTIME_DATA_DIR: "   ", XDG_DATA_HOME: "/x/data" })).toBe(fallback);
    expect(linuxPaths.runtimeDataDir({ SPACEFLEET_RUNTIME_DATA_DIR: "", XDG_DATA_HOME: "/x/data" })).toBe(fallback);
  });

  it("keeps Electron user data in the legacy <appData>/<scope>/<name> dir", () => {
    expect(linuxPaths.appUserDataDir({ appData: "/home/a/.config", productName: "SpaceBadger", legacyDir: ["@space", "badger"] })).toBe(
      "/home/a/.config/@space/badger",
    );
  });

  it("reads process.env when no env is given", () => {
    const saved = process.env.SPACEFLEET_RUNTIME_DATA_DIR;
    process.env.SPACEFLEET_RUNTIME_DATA_DIR = "/srv/from-process-env";
    try {
      expect(linuxPaths.runtimeDataDir()).toBe("/srv/from-process-env");
    } finally {
      if (saved === undefined) delete process.env.SPACEFLEET_RUNTIME_DATA_DIR;
      else process.env.SPACEFLEET_RUNTIME_DATA_DIR = saved;
    }
  });

  it("puts user data under XDG_DATA_HOME, else ~/.local/share", () => {
    expect(linuxPaths.userDataBase({ XDG_DATA_HOME: "/x/data" })).toBe("/x/data");
    expect(linuxPaths.userDataBase({})).toBe(join(homedir(), ".local", "share"));
  });
});

describe("linux prepareRuntimeDataDir", () => {
  let root: string;
  let xdg: string;
  let legacy: string;
  let target: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-linux-paths-"));
    xdg = join(root, "xdg");
    legacy = join(root, "legacy-spacefleet-runtime");
    target = join(xdg, "SpaceFleet", "runtime");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A legacy dir as the previous build left it: data plus the bookkeeping of a dead runtime. */
  const seedLegacy = () => {
    mkdirSync(join(legacy, "library"), { recursive: true });
    writeFileSync(join(legacy, "runtime_keys.json"), '{"u1":"a2V5"}');
    writeFileSync(join(legacy, "runtime_jobs.db"), "jobs");
    writeFileSync(join(legacy, "library", "library.db"), "core");
    writeFileSync(join(legacy, "runtime.pid"), "999999");
    writeFileSync(join(legacy, "runtime.log"), "old log");
  };

  it("@bugfix @regression-proof creates the default dir owner-only (it holds keys and databases)", () => {
    const { log } = recordingLog();
    const dir = prepareLinuxRuntimeDataDir({ env: { XDG_DATA_HOME: xdg }, log }, { legacyDir: legacy, uid });
    const mode = statSync(dir).mode & 0o777;
    console.info("[linux-paths:prepare] created", { dir, mode: mode.toString(8) });
    expect(dir).toBe(target);
    expect(mode).toBe(0o700);
  });

  it("creates an overridden dir and never migrates into it", () => {
    seedLegacy();
    const override = join(root, "override");
    const { lines, log } = recordingLog();
    expect(prepareLinuxRuntimeDataDir({ env: { SPACEFLEET_RUNTIME_DATA_DIR: override, XDG_DATA_HOME: xdg }, log }, { legacyDir: legacy, uid, isAlive: neverAlive })).toBe(override);
    expect(listing(override)).toEqual([]);
    expect(lines).toEqual([]);
  });

  it("@bugfix @regression-proof copies the legacy /tmp data into the new dir once, leaving the rest of the legacy dir and shredding the plaintext key file @req RT-SEC-05[runtime]", () => {
    seedLegacy();
    const { lines, log } = recordingLog();
    const dir = prepareLinuxRuntimeDataDir({ env: { XDG_DATA_HOME: xdg }, log }, { legacyDir: legacy, uid, isAlive: neverAlive });
    console.info("[linux-paths:migrate] after first start", { target: listing(dir), legacy: listing(legacy), lines });
    expect(listing(dir)).toEqual(["library", "runtime_jobs.db", "runtime_keys.json"]);
    expect(readFileSync(join(dir, "runtime_keys.json"), "utf8")).toBe('{"u1":"a2V5"}');
    expect(readFileSync(join(dir, "library", "library.db"), "utf8")).toBe("core");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    // RT-SEC-05: the plaintext key file is not left behind in the shared /tmp.
    expect(listing(legacy)).not.toContain("runtime_keys.json");
    expect(listing(legacy)).toContain("runtime_jobs.db");
    expect(listing(join(xdg, "SpaceFleet"))).toEqual(["runtime"]); // no staging dir left behind
    expect(lines.filter((l) => l.level === "info").map((l) => l.message)).toEqual([expect.stringMatching(/migrated the legacy runtime data dir/)]);

    // Second start: the new dir has data, so the legacy dir is never read again.
    writeFileSync(join(legacy, "runtime_jobs.db"), "stale jobs");
    writeFileSync(join(dir, "runtime_jobs.db"), "jobs v2");
    prepareLinuxRuntimeDataDir({ env: { XDG_DATA_HOME: xdg }, log }, { legacyDir: legacy, uid, isAlive: neverAlive });
    expect(readFileSync(join(dir, "runtime_keys.json"), "utf8")).toBe('{"u1":"a2V5"}');
    expect(readFileSync(join(dir, "runtime_jobs.db"), "utf8")).toBe("jobs v2");
  });

  it("@bugfix @regression-proof keeps the guardian's bookkeeping already in the new dir while migrating", () => {
    seedLegacy();
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "runtime.log"), "new log");
    const { log } = recordingLog();
    prepareLinuxRuntimeDataDir({ env: { XDG_DATA_HOME: xdg }, log }, { legacyDir: legacy, uid, isAlive: neverAlive });
    expect(listing(target)).toEqual(["library", "runtime.log", "runtime_jobs.db", "runtime_keys.json"]);
    expect(readFileSync(join(target, "runtime.log"), "utf8")).toBe("new log");
  });

  it("@bugfix @regression-proof never migrates a legacy dir owned by another user", () => {
    seedLegacy();
    const { lines, log } = recordingLog();
    const dir = prepareLinuxRuntimeDataDir({ env: { XDG_DATA_HOME: xdg }, log }, { legacyDir: legacy, uid: uid + 1, isAlive: neverAlive });
    expect(listing(dir)).toEqual([]);
    expect(lines).toEqual([expect.objectContaining({ level: "warn", message: expect.stringMatching(/another user/) })]);
  });

  it("@bugfix @regression-proof never migrates through a symlink", () => {
    const real = join(root, "real");
    mkdirSync(real);
    writeFileSync(join(real, "runtime_keys.json"), "{}");
    symlinkSync(real, legacy);
    const { lines, log } = recordingLog();
    const dir = prepareLinuxRuntimeDataDir({ env: { XDG_DATA_HOME: xdg }, log }, { legacyDir: legacy, uid, isAlive: neverAlive });
    expect(listing(dir)).toEqual([]);
    expect(lines).toEqual([expect.objectContaining({ level: "warn", message: expect.stringMatching(/not a real directory/) })]);
  });

  it("waits while a runtime of the previous build still uses the legacy dir", () => {
    seedLegacy();
    const { lines, log } = recordingLog();
    const dir = prepareLinuxRuntimeDataDir({ env: { XDG_DATA_HOME: xdg }, log }, { legacyDir: legacy, uid, isAlive: (pid) => pid === 999999 });
    expect(listing(dir)).toEqual([]);
    expect(lines).toEqual([expect.objectContaining({ level: "warn", message: expect.stringMatching(/still uses/) })]);
    // Once that runtime is gone the next start migrates.
    prepareLinuxRuntimeDataDir({ env: { XDG_DATA_HOME: xdg }, log }, { legacyDir: legacy, uid, isAlive: neverAlive });
    expect(listing(dir)).toEqual(["library", "runtime_jobs.db", "runtime_keys.json"]);
  });

  const lockPath = () => join(xdg, "SpaceFleet", ".runtime.migrate.lock");
  const stagingPath = () => join(xdg, "SpaceFleet", ".runtime.migrating");
  /** The lock (and optionally a half-written staging dir) another process left, as `pid`. */
  const seedLock = (content: string) => {
    mkdirSync(join(xdg, "SpaceFleet"), { recursive: true });
    writeFileSync(lockPath(), content);
  };

  it("recovers from a migration interrupted mid-copy (dead lock owner, stale staging dir) without losing data", () => {
    seedLegacy();
    seedLock("424242");
    mkdirSync(stagingPath());
    writeFileSync(join(stagingPath(), "runtime_keys.json"), "half-wri");
    const { lines, log } = recordingLog();
    const dir = prepareLinuxRuntimeDataDir({ env: { XDG_DATA_HOME: xdg }, log }, { legacyDir: legacy, uid, isAlive: neverAlive });
    expect(readFileSync(join(dir, "runtime_keys.json"), "utf8")).toBe('{"u1":"a2V5"}');
    expect(listing(join(xdg, "SpaceFleet"))).toEqual(["runtime"]); // lock and staging gone
    expect(lines.map((l) => l.message)).toEqual([expect.stringMatching(/breaking the lock/), expect.stringMatching(/migrated the legacy/)]);
  });

  it("@bugfix @regression-proof waits for another process's migration instead of starting on an empty dir", () => {
    seedLegacy();
    seedLock("424242");
    let polls = 0;
    // The other process (pid 424242) finishes on our third look: its data lands and it releases the lock.
    const isAlive = (pid: number) => {
      if (pid !== 424242) return false;
      polls += 1;
      if (polls === 3) {
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "runtime_jobs.db"), "migrated-by-other");
        rmSync(lockPath());
      }
      return true;
    };
    const { lines, log } = recordingLog();
    const dir = prepareLinuxRuntimeDataDir({ env: { XDG_DATA_HOME: xdg }, log }, { legacyDir: legacy, uid, isAlive, pollMs: 1 });
    console.info("[linux-paths:wait] after waiting", { target: listing(dir), polls, lines });
    expect(polls).toBe(3);
    expect(listing(dir)).toEqual(["runtime_jobs.db"]);
    expect(readFileSync(join(dir, "runtime_jobs.db"), "utf8")).toBe("migrated-by-other");
    expect(lines).toEqual([expect.objectContaining({ level: "info", message: expect.stringMatching(/another process is migrating .*waiting for it/) })]);
  });

  it("@bugfix @regression-proof abandons the migration, keeping the live data, when the new dir receives data during the copy", () => {
    seedLegacy();
    const { lines, log } = recordingLog();
    // A process that stopped waiting started its runtime meanwhile: fresh stores in the new dir.
    const beforeFinalize = () => {
      mkdirSync(join(target, "library"), { recursive: true });
      writeFileSync(join(target, "runtime_jobs.db"), "FRESH");
      writeFileSync(join(target, "library", "library.db"), "FRESH-CORE");
      writeFileSync(join(target, "runtime.spawn.lock"), "spawn");
    };
    const dir = prepareLinuxRuntimeDataDir({ env: { XDG_DATA_HOME: xdg }, log }, { legacyDir: legacy, uid, isAlive: neverAlive, beforeFinalize });
    expect(listing(dir)).toEqual(["library", "runtime.spawn.lock", "runtime_jobs.db"]);
    expect(readFileSync(join(dir, "runtime_jobs.db"), "utf8")).toBe("FRESH");
    expect(readFileSync(join(dir, "library", "library.db"), "utf8")).toBe("FRESH-CORE");
    expect(listing(join(xdg, "SpaceFleet"))).toEqual(["runtime"]);
    expect(lines).toEqual([expect.objectContaining({ level: "warn", message: expect.stringMatching(/received data during the migration/) })]);
  });

  it("stops waiting for a stuck migration after waitMs and starts without it", () => {
    seedLegacy();
    seedLock("424242");
    const { lines, log } = recordingLog();
    const dir = prepareLinuxRuntimeDataDir(
      { env: { XDG_DATA_HOME: xdg }, log },
      { legacyDir: legacy, uid, isAlive: (pid) => pid === 424242, waitMs: 30, pollMs: 5 },
    );
    expect(listing(dir)).toEqual([]);
    expect(existsSync(lockPath())).toBe(true); // still the other process's
    expect(lines.map((l) => l.message)).toEqual([expect.stringMatching(/waiting for it/), expect.stringMatching(/starting without waiting further/)]);
  });

  it("treats a lock without an owner pid as abandoned only once it is old", () => {
    seedLegacy();
    seedLock("");
    const { lines, log } = recordingLog();
    const seams = { legacyDir: legacy, uid, isAlive: neverAlive, waitMs: 20, pollMs: 5, ownerlessStaleMs: 60_000 };
    expect(listing(prepareLinuxRuntimeDataDir({ env: { XDG_DATA_HOME: xdg }, log }, seams))).toEqual([]);
    expect(existsSync(lockPath())).toBe(true);
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath(), old, old);
    const dir = prepareLinuxRuntimeDataDir({ env: { XDG_DATA_HOME: xdg }, log }, seams);
    expect(listing(dir)).toEqual(["library", "runtime_jobs.db", "runtime_keys.json"]);
    expect(lines.map((l) => l.message)).toContainEqual(expect.stringMatching(/breaking the lock/));
  });

  it("does nothing when there is no legacy dir or it holds only bookkeeping", () => {
    const { lines, log } = recordingLog();
    expect(listing(prepareLinuxRuntimeDataDir({ env: { XDG_DATA_HOME: xdg }, log }, { legacyDir: legacy, uid }))).toEqual([]);
    mkdirSync(legacy);
    writeFileSync(join(legacy, "runtime.log"), "log");
    expect(listing(prepareLinuxRuntimeDataDir({ env: { XDG_DATA_HOME: xdg }, log }, { legacyDir: legacy, uid, isAlive: neverAlive }))).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe("owner-only restriction", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sf-linux-owner-only-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("restrictFileToOwner makes a file 0600 and restrictDirToOwner tightens a 0755 dir to 0700", () => {
    const file = join(root, "secret");
    writeFileSync(file, "x", { mode: 0o644 });
    linuxPaths.restrictFileToOwner(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const dir = join(root, "d");
    mkdirSync(dir, { mode: 0o755 });
    linuxPaths.restrictDirToOwner(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("throws for a path that does not exist", () => {
    expect(() => linuxPaths.restrictFileToOwner(join(root, "missing"))).toThrow();
  });
});
