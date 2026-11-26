/**
 * The desktop platform conformance suite (ADR 2026-10-13-desktop-platform-layer).
 *
 * Every `DesktopPlatform` implementation must pass ALL of it, on its own OS,
 * unchanged. It drives the real OS: real sockets / named pipes, real child
 * process trees, real suspend/resume, real affinity. Nothing is mocked, so a
 * green run on a host is the proof that implementation works on that host.
 *
 * Runners:
 *  - vitest: each implementation package has `tests/conformance.test.ts`
 *    looping over `conformanceChecks` (Linux: CI, `desktop-test` job);
 *  - standalone: `bun packages/desktop-platform/src/conformance-cli.ts`
 *    (TAP on stdout, exit 1 on failure) - the command used inside the Windows
 *    VM and on the future Mac runner.
 *
 * Some checks run helper processes with `bun` (the runtime is a Bun process),
 * so `bun` must be on PATH or be the running interpreter.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { advertisedHardwareEncoders, pickHardwareEncoder } from "../hardware";
import type { DesktopPlatform, Env, HardwareEncoder } from "../types";

export type ConformanceContext = {
  platform: DesktopPlatform;
  /** Absolute path of a module that exports `platform` (the implementation under test); loaded by helper processes. */
  platformModule: string;
  /** Scratch directory, removed after the run. */
  tmp: string;
  log: (line: string) => void;
};

export type ConformanceCheck = {
  id: string;
  title: string;
  /** Resolve to a string to report the check as skipped with that reason. */
  run: (ctx: ConformanceContext) => Promise<string | void>;
};

export type ConformanceResult = { id: string; title: string; status: "ok" | "skipped" | "failed"; detail?: string; ms: number };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function conformanceAssert(condition: unknown, message: string, state?: unknown): asserts condition {
  if (condition) return;
  let dump = "";
  if (state !== undefined) {
    try {
      dump = `\nstate: ${JSON.stringify(state, null, 2)}`;
    } catch {
      dump = "\nstate: (unserialisable)";
    }
  }
  throw new Error(`${message}${dump}`);
}
const assert: typeof conformanceAssert = conformanceAssert;

const waitFor = async (condition: () => boolean, timeoutMs: number, what: string, state?: () => unknown) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) assert(false, `timed out after ${timeoutMs} ms waiting for ${what}`, state?.());
    await sleep(25);
  }
};

const bunExecutable = (env: Env = process.env): string => (process.versions.bun ? process.execPath : env.BUN_PATH || "bun");

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

type Helper = { child: ChildProcess; lines: () => string[]; text: () => string; stop: () => void };

/** Spawn `bun <script> ...args` with stdout captured. `detached` follows the platform's own spawn options. */
const spawnHelper = (ctx: ConformanceContext, script: string, args: string[] = [], detached = false): Helper => {
  const child = spawn(bunExecutable(), [script, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    ...ctx.platform.processes.spawnOptions({ detached }),
  });
  let out = "";
  let err = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString("utf8");
  });
  child.on("error", (error) => {
    err += `spawn error: ${error.message}\n`;
  });
  return {
    child,
    lines: () => out.split("\n").filter(Boolean),
    text: () => `${out}${err ? `\n[stderr]\n${err}` : ""}`,
    stop: () => {
      try {
        if (child.pid && pidAlive(child.pid)) process.kill(child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    },
  };
};

const writeScript = (ctx: ConformanceContext, name: string, body: string): string => {
  const path = join(ctx.tmp, name);
  writeFileSync(path, body, "utf8");
  return path;
};

const HEARTBEAT = `setInterval(() => process.stdout.write("t\\n"), 20);\n`;

const TREE = (heartbeatScript: string) => `
import { spawn } from "node:child_process";
const grandchild = spawn(process.execPath, [${JSON.stringify(heartbeatScript)}], { stdio: ["ignore", "ignore", "ignore"] });
console.log("grandchild " + grandchild.pid);
setInterval(() => {}, 1000);
`;

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

const checks: ConformanceCheck[] = [];
const check = (id: string, title: string, run: ConformanceCheck["run"]) => {
  checks.push({ id, title, run });
};

check("identity", "reports a known platform id and arch", async ({ platform }) => {
  assert(["linux", "windows", "macos"].includes(platform.id), "platform.id is one of linux|windows|macos", platform.id);
  assert(["x64", "arm64"].includes(platform.arch), "platform.arch is x64|arm64", platform.arch);
});

check("binaries-names", "executableName appends the OS executable suffix and nothing else", async ({ platform }) => {
  const suffix = platform.id === "windows" ? ".exe" : "";
  for (const name of ["ffmpeg", "ffprobe", "mpv"] as const) {
    assert(platform.binaries.executableName(name) === `${name}${suffix}`, `executableName(${name})`, platform.binaries.executableName(name));
  }
  assert(platform.binaries.executableName(`mpv${suffix}`) === `mpv${suffix}`, "executableName is idempotent");
});

check("binaries-resolve", "resolves bundled binaries from vendor/deps/<os>-<arch> and <resources>/deps", async (ctx) => {
  const { platform, tmp } = ctx;
  const names = ["ffmpeg", "ffprobe", "mpv"] as const;
  // Where each binary sits below the deps dir: `bin/<exe>`, unless the OS bundles it differently (macOS: mpv's helper app).
  const bundled = (depsDir: string, name: (typeof names)[number]) =>
    join(depsDir, platform.binaries.bundledPath?.(name) ?? join("bin", platform.binaries.executableName(name)));
  const plant = (path: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "x");
  };
  const checkout = join(tmp, "checkout");
  const devDeps = join(checkout, "vendor", "deps", `${platform.id}-${platform.arch}`);
  const devBin = join(devDeps, "bin");
  mkdirSync(join(checkout, "apps", "badger", "desktop"), { recursive: true });
  for (const name of names) plant(bundled(devDeps, name));
  for (const name of names) {
    const found = platform.binaries.resolve(name, { cwd: join(checkout, "apps", "badger", "desktop"), env: {} });
    assert(found?.path === bundled(devDeps, name), `dev checkout resolves ${name}`, {
      found,
      searched: platform.binaries.searchDirs({ cwd: join(checkout, "apps", "badger", "desktop"), env: {} }),
    });
    assert(found.dir === dirname(bundled(devDeps, name)), `dev checkout dir for ${name}`, found);
  }
  assert(
    platform.binaries.searchDirs({ cwd: join(checkout, "apps", "badger", "desktop"), env: {} }).includes(devBin),
    "searchDirs lists the checkout's bin/",
  );
  const resources = join(tmp, "installed", "resources");
  const packagedDeps = join(resources, "deps");
  for (const name of names) plant(bundled(packagedDeps, name));
  for (const name of names) {
    const found = platform.binaries.resolve(name, {
      appRoot: join(resources, "app.asar"),
      resourcesPath: resources,
      cwd: join(tmp, "elsewhere"),
      env: {},
    });
    assert(found?.path === bundled(packagedDeps, name), `packaged resolves ${name}`, found);
    assert(found.source === "packaged-deps", `packaged source for ${name}`, found);
  }
  const nothing = platform.binaries.resolve("mpv", { cwd: join(tmp, "nowhere"), env: {} });
  assert(nothing === undefined, "an absent binary resolves to undefined, never a bare name", nothing);
  assert(platform.binaries.resolveAll("mpv", { cwd: join(tmp, "nowhere"), env: {} }).length === 0, "resolveAll finds nothing for an absent binary");
  const all = platform.binaries.resolveAll("ffmpeg", { cwd: join(checkout, "apps", "badger", "desktop"), env: {} });
  assert(all[0]?.path === bundled(devDeps, "ffmpeg"), "resolveAll lists the best candidate first", all);
  const launch = platform.binaries.launchEnv({ libDirs: [devBin] }, { KEEP: "1" });
  assert(launch.KEEP === "1" && JSON.stringify(launch).includes(devBin.replaceAll("\\", "\\\\")), "launchEnv exposes the library dirs on a copy", launch);
});

check("binaries-library-path", "withLibraryPath returns a copy that exposes the library dirs", async ({ platform, tmp }) => {
  const input: Env = { KEEP: "1" };
  const libDir = join(tmp, "libs");
  const out = platform.binaries.withLibraryPath(input, [libDir]);
  assert(out !== input && out.KEEP === "1", "returns a copy that keeps the other variables", out);
  assert(!JSON.stringify(input).includes(libDir), "does not mutate its input", input);
  assert(JSON.stringify(out).includes(libDir.replaceAll("\\", "\\\\")), "the library dir is exposed in the environment", out);
});

check("paths", "runtime data dir is absolute, persistent (not under the temp dir), overridable, prepared owner-only and writable; user data base is absolute", async ({ platform, tmp, log }) => {
  const dir = platform.paths.runtimeDataDir({});
  log(`default runtime data dir: ${dir}`);
  assert(dir.length > 0 && (dir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(dir)), "default runtime data dir is absolute", dir);
  // It holds keys, job queues and databases: a temp dir is wiped at reboot (Linux /tmp is a tmpfs on most distros).
  const underTemp = (root: string) => {
    const rel = relative(resolve(root), resolve(dir));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  assert(!underTemp(tmpdir()) && !underTemp("/tmp"), "default runtime data dir is not under the temp dir", { dir, tmpdir: tmpdir() });
  const override = join(tmp, "override");
  assert(platform.paths.runtimeDataDir({ SPACEFLEET_RUNTIME_DATA_DIR: `  ${override}  ` }) === override, "SPACEFLEET_RUNTIME_DATA_DIR wins (trimmed)");
  assert(platform.paths.runtimeDataDir({ SPACEFLEET_RUNTIME_DATA_DIR: "   " }) === dir, "a blank override is ignored");
  const prepared = platform.paths.prepareRuntimeDataDir({ env: { SPACEFLEET_RUNTIME_DATA_DIR: override }, log: (level, message) => log(`${level} ${message}`) });
  assert(prepared === override && existsSync(override), "prepareRuntimeDataDir creates the resolved dir and returns it", { prepared, override });
  // POSIX modes only: Windows protects %LOCALAPPDATA% with its ACL and reports synthetic mode bits.
  if (platform.id !== "windows") {
    const mode = statSync(override).mode & 0o777;
    assert((mode & 0o077) === 0, "prepareRuntimeDataDir creates the dir owner-only", mode.toString(8));
  }
  // Probe the real default, then remove whatever the probe created: the host keeps no empty dir with default modes.
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
  const probe = join(dir, `.conformance-${process.pid}`);
  try {
    writeFileSync(probe, "ok");
    assert(existsSync(probe), "the default runtime data dir is writable", dir);
  } finally {
    rmSync(created ?? probe, { recursive: true, force: true });
  }
  const base = platform.paths.userDataBase({});
  assert(base.length > 0 && (base.startsWith("/") || /^[A-Za-z]:[\\/]/.test(base)), "user data base is absolute", base);
});

check("paths", "restrictFileToOwner / restrictDirToOwner make a secret file owner-only (POSIX modes asserted; Windows: icacls must succeed and the file stay readable by this user)", async ({ platform, tmp }) => {
  const dir = join(tmp, "owner-only");
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  platform.paths.restrictDirToOwner(dir);
  const file = join(dir, "owner.secret");
  writeFileSync(file, "", { mode: 0o644 });
  platform.paths.restrictFileToOwner(file);
  writeFileSync(file, "secret");
  assert(readFileSync(file, "utf8") === "secret", "the owner can still write and read the restricted file", file);
  // POSIX modes only: Windows reports synthetic mode bits, its ACL is not readable through stat.
  if (platform.id !== "windows") {
    assert((statSync(file).mode & 0o777) === 0o600, "restrictFileToOwner leaves the file 0600", (statSync(file).mode & 0o777).toString(8));
    assert((statSync(dir).mode & 0o777) === 0o700, "restrictDirToOwner leaves the dir 0700", (statSync(dir).mode & 0o777).toString(8));
  }
});

check("mpv-ipc", "mpv IPC endpoint: unique, exists once listening (without connecting), line-JSON round trip, removable", async ({ platform, log }) => {
  const token = `conf-${process.pid}-${Date.now()}`;
  const endpoint = platform.mpvIpc.endpoint(token);
  assert(endpoint !== platform.mpvIpc.endpoint(`${token}-other`), "endpoints differ per token", endpoint);
  platform.mpvIpc.remove(endpoint);
  assert(!platform.mpvIpc.exists(endpoint), "nothing exists before listening", endpoint);
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        socket.write(`${JSON.stringify({ error: "success", data: JSON.parse(line).command[0] })}\n`);
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => resolve());
  });
  try {
    log(`mpv-ipc: listening on ${endpoint}`);
    assert(platform.mpvIpc.exists(endpoint), "exists() is true while listening", endpoint);
    // exists() runs before every mpv request: it must not take a connection (mpv serves one client per
    // pipe instance, and a probe that connects makes the real request find no free instance).
    for (let i = 0; i < 50; i++) assert(platform.mpvIpc.exists(endpoint), "exists() stays true under repeated checks", `check ${i + 1}`);
    await sleep(150);
    assert(connections === 0, "exists() never connects to the endpoint", `${connections} connection(s) after 50 checks`);
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = platform.mpvIpc.connect(endpoint, () => {
        socket.write(`${JSON.stringify({ command: ["get_property", "pid"], request_id: 1 })}\n`);
      });
      let got = "";
      socket.on("data", (chunk) => {
        got += chunk.toString("utf8");
        if (got.includes("\n")) {
          socket.destroy();
          resolve(got.trim());
        }
      });
      socket.on("error", reject);
      setTimeout(() => reject(new Error("no reply within 3 s")), 3000).unref();
    });
    assert(JSON.parse(reply).data === "get_property", "JSON line round trip", reply);
    const refused = await new Promise<string>((resolve) => {
      const other = platform.mpvIpc.endpoint(`${token}-nobody`);
      const socket = platform.mpvIpc.connect(other);
      socket.on("error", (error) => resolve((error as NodeJS.ErrnoException).code ?? "error"));
      socket.on("connect", () => {
        socket.destroy();
        resolve("connected");
      });
    });
    assert(refused !== "connected", "connecting to an endpoint nobody listens on fails", refused);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  platform.mpvIpc.remove(endpoint);
  platform.mpvIpc.remove(endpoint);
  assert(!platform.mpvIpc.exists(endpoint), "remove() leaves nothing behind and is repeatable", endpoint);
});

check("process-tree", "a detached group leader's whole tree is signalled and dies", async (ctx) => {
  const { platform, log } = ctx;
  const heartbeat = writeScript(ctx, "heartbeat.mjs", HEARTBEAT);
  const tree = writeScript(ctx, "tree.mjs", TREE(heartbeat));
  const helper = spawnHelper(ctx, tree, [], true);
  try {
    const leader = helper.child.pid;
    assert(leader !== undefined, "tree leader spawned", helper.text());
    await waitFor(() => helper.lines().some((line) => line.startsWith("grandchild ")), 15_000, "the grandchild pid", helper.text);
    const grandchild = Number(helper.lines().find((line) => line.startsWith("grandchild "))!.split(" ")[1]);
    log(`process-tree: leader=${leader} grandchild=${grandchild}`);
    assert(platform.processes.group.isAlive(leader), "group alive while running", { leader, grandchild });
    const asked = platform.processes.group.signal(leader, "terminate");
    log(`process-tree: terminate delivered=${asked}`);
    const forced = platform.processes.group.signal(leader, "kill");
    assert(typeof forced === "boolean", "signal returns a boolean");
    await waitFor(() => !platform.processes.group.isAlive(leader), 10_000, "the group to die", () => ({ leader, grandchild, out: helper.text() }));
    await waitFor(
      () => !pidAlive(grandchild) || platform.processes.readCommandLineSync(grandchild) === null,
      10_000,
      "the grandchild to die with its leader",
      () => ({ leader, grandchild, commandLine: platform.processes.readCommandLineSync(grandchild) })
    );
    platform.processes.group.signal(leader, "kill"); // signalling a dead group must not throw
  } finally {
    helper.stop();
  }
});

check("process-graceful-stop", "a stop request reaches an installed handler and the process exits cleanly (not killed)", async (ctx) => {
  const { platform, log } = ctx;
  const stoppable = writeScript(
    ctx,
    "stoppable.mjs",
    `
const { platform } = await import(${JSON.stringify(ctx.platformModule)});
platform.processes.gracefulStop.install((source) => {
  process.stdout.write("stopped " + source + "\\n", () => process.exit(0));
});
console.log("ready");
setInterval(() => {}, 1000);
`
  );
  const helper = spawnHelper(ctx, stoppable);
  try {
    const pid = helper.child.pid!;
    await waitFor(() => helper.lines().includes("ready"), 20_000, "the helper to install its stop handler", helper.text);
    const delivered = platform.processes.gracefulStop.request(pid);
    log(`process-graceful-stop: request(${pid}) delivered=${delivered}`);
    assert(delivered, "request() reports the stop request as delivered", { pid, out: helper.text() });
    await waitFor(() => helper.child.exitCode !== null || helper.child.signalCode !== null, 15_000, "the helper to exit", helper.text);
    assert(
      helper.child.exitCode === 0 && helper.child.signalCode === null,
      "the helper exits with code 0 (a graceful exit, not a kill)",
      { exitCode: helper.child.exitCode, signalCode: helper.child.signalCode, out: helper.text() }
    );
    assert(
      helper.lines().some((line) => line.startsWith("stopped ")),
      "the helper's handler ran and named the request source",
      helper.text()
    );
    assert(!platform.processes.gracefulStop.request(pid), "request() to a process that is gone is not delivered", { pid });
  } finally {
    helper.stop();
  }
});

check("process-suspend", "suspend freezes a process in place and resume continues it", async (ctx) => {
  const { platform, log } = ctx;
  const heartbeat = writeScript(ctx, "heartbeat-suspend.mjs", HEARTBEAT);
  const helper = spawnHelper(ctx, heartbeat);
  try {
    const pid = helper.child.pid!;
    await waitFor(() => helper.lines().length >= 5, 15_000, "the first heartbeats", helper.text);
    const handle = platform.processes.control.open(pid);
    try {
      handle.suspend();
      await sleep(250); // let beats already in the pipe drain
      const frozenAt = helper.lines().length;
      await sleep(600);
      const stillFrozen = helper.lines().length;
      log(`process-suspend: beats ${frozenAt} -> ${stillFrozen} over 600 ms frozen`);
      assert(stillFrozen - frozenAt <= 1, "no heartbeats while suspended", { frozenAt, stillFrozen });
      handle.resume();
      await sleep(600);
      const resumed = helper.lines().length;
      log(`process-suspend: beats after resume ${resumed}`);
      assert(resumed - stillFrozen >= 5, "heartbeats continue after resume", { stillFrozen, resumed });
    } finally {
      try {
        handle.resume();
      } catch {
        // best effort so the helper can be killed
      }
      handle.close();
    }
  } finally {
    helper.stop();
  }
});

check("process-throttle", "throttle applies the backend's throttleKind (one core / background band) and unthrottle restores it", async (ctx) => {
  const { platform, log } = ctx;
  const kind = platform.processes.control.throttleKind;
  assert(kind === "one-core" || kind === "background-band", "control.throttleKind is one-core | background-band", kind);
  if (kind === "one-core" && availableParallelism() < 2) return "needs a host with at least 2 logical cores";
  const heartbeat = writeScript(ctx, "heartbeat-throttle.mjs", HEARTBEAT);
  const helper = spawnHelper(ctx, heartbeat);
  try {
    const pid = helper.child.pid!;
    await waitFor(() => helper.lines().length >= 2, 15_000, "the helper to run", helper.text);
    const handle = platform.processes.control.open(pid);
    try {
      // INGS-LANE-02: one core on Linux / Windows; macOS has no affinity API, so its throttle is the background band.
      const read = kind === "one-core" ? handle.allowedCpuCount : handle.inBackgroundBand;
      assert(read !== undefined, `handles report ${kind === "one-core" ? "allowedCpuCount" : "inBackgroundBand"} (conformance reads the throttle back)`);
      const before = read();
      handle.throttle();
      const during = read();
      handle.throttle(); // idempotent
      const duringAgain = read();
      handle.unthrottle();
      const after = read();
      log(`process-throttle (${kind}): before=${before} throttled=${during}/${duringAgain} after=${after}`);
      if (kind === "one-core") {
        assert(typeof before === "number" && before >= 2, "the helper starts on at least 2 cores", { before });
        assert(during === 1 && duringAgain === 1, "throttle leaves exactly one core", { during, duringAgain });
      } else {
        assert(before === false, "the helper starts outside the background band", { before });
        assert(during === true && duringAgain === true, "throttle puts the process in the background band", { during, duringAgain });
      }
      assert(after === before, "unthrottle restores the original state", { before, after });
      const resumed = helper.lines().length;
      await waitFor(() => helper.lines().length > resumed, 5_000, "the helper to keep running after unthrottle", helper.text);
    } finally {
      handle.close();
    }
  } finally {
    helper.stop();
  }
});

check("process-command-line", "reads another process's command line", async (ctx) => {
  const { platform } = ctx;
  const marker = `sf-conformance-marker-${process.pid}-${Date.now()}`;
  const script = writeScript(ctx, `${marker}.mjs`, HEARTBEAT);
  const helper = spawnHelper(ctx, script);
  try {
    const pid = helper.child.pid!;
    await waitFor(() => helper.lines().length >= 1, 15_000, "the helper to run", helper.text);
    const sync = platform.processes.readCommandLineSync(pid);
    const viaPromise = await platform.processes.readCommandLine(pid);
    assert(sync?.includes(marker), "readCommandLineSync contains the script name", { sync });
    assert(viaPromise?.includes(marker), "readCommandLine contains the script name", { viaPromise });
    assert((await platform.processes.readCommandLine(2 ** 22 - 7)) === null, "an unknown pid reads as null");
  } finally {
    helper.stop();
  }
});

check("process-namespace", "ownPidNamespace is null or a numeric id", async ({ platform }) => {
  const ns = platform.processes.ownPidNamespace();
  assert(ns === null || /^\d+$/.test(ns), "ownPidNamespace", ns);
});

check("process-spawn-options", "detached children outlive the process that spawned them", async (ctx) => {
  const { platform, log } = ctx;
  const heartbeat = writeScript(ctx, "heartbeat-orphan.mjs", HEARTBEAT);
  const parent = writeScript(
    ctx,
    "spawner.mjs",
    `
import { spawn } from "node:child_process";
const { platform } = await import(${JSON.stringify(ctx.platformModule)});
const child = spawn(process.execPath, [${JSON.stringify(heartbeat)}], {
  stdio: "ignore",
  ...platform.processes.spawnOptions({ detached: true }),
});
child.unref();
console.log("child " + child.pid);
process.exit(0);
`
  );
  const helper = spawnHelper(ctx, parent);
  let childPid = 0;
  try {
    await waitFor(() => helper.lines().some((line) => line.startsWith("child ")), 20_000, "the spawner to report its child", helper.text);
    childPid = Number(helper.lines().find((line) => line.startsWith("child "))!.split(" ")[1]);
    await waitFor(() => helper.child.exitCode !== null, 10_000, "the spawner to exit", helper.text);
    await sleep(750);
    log(`process-spawn-options: spawner exited, child ${childPid} alive=${pidAlive(childPid)}`);
    assert(pidAlive(childPid), "the detached child survives its parent", { childPid, out: helper.text() });
    assert(platform.processes.group.isAlive(childPid), "and its group is alive", { childPid });
  } finally {
    if (childPid) {
      platform.processes.group.signal(childPid, "kill");
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // gone
      }
    }
    helper.stop();
  }
});

check("process-child-lifetime", "a child spawned through childLifetime dies when its parent is killed", async (ctx) => {
  const { platform, log } = ctx;
  const supported = await platform.processes.childLifetime.supported();
  if (!supported) return "childLifetime.supported() is false on this host";
  const exitZero = writeScript(ctx, "exit-zero.mjs", "process.exit(0);\n");
  const wrapped = await platform.processes.childLifetime.wrap(bunExecutable(), [exitZero], {});
  const quick = spawn(wrapped.command, wrapped.args, { stdio: "ignore" });
  const code = await new Promise<number | null>((resolve) => quick.on("exit", (c) => resolve(c)));
  assert(code === 0, "a wrapped command still runs and exits 0", { wrapped, code });

  const heartbeat = writeScript(ctx, "heartbeat-lifetime.mjs", HEARTBEAT);
  const parent = writeScript(
    ctx,
    "lifetime-parent.mjs",
    `
import { spawn } from "node:child_process";
const { platform } = await import(${JSON.stringify(ctx.platformModule)});
const wrapped = await platform.processes.childLifetime.wrap(process.execPath, [${JSON.stringify(heartbeat)}], {});
const child = spawn(wrapped.command, wrapped.args, { stdio: ["ignore", "ignore", "ignore"] });
platform.processes.childLifetime.afterSpawn(child.pid);
console.log("child " + child.pid);
setInterval(() => {}, 1000);
`
  );
  const helper = spawnHelper(ctx, parent);
  try {
    await waitFor(() => helper.lines().some((line) => line.startsWith("child ")), 20_000, "the parent to report its child", helper.text);
    const childPid = Number(helper.lines().find((line) => line.startsWith("child "))!.split(" ")[1]);
    assert(pidAlive(childPid), "the child runs while its parent lives", { childPid });
    process.kill(helper.child.pid!, "SIGKILL");
    log(`process-child-lifetime: killed parent ${helper.child.pid}, waiting for child ${childPid}`);
    await waitFor(
      () => !pidAlive(childPid) || platform.processes.readCommandLineSync(childPid) === null,
      10_000,
      "the child to die with its parent",
      () => ({ childPid, commandLine: platform.processes.readCommandLineSync(childPid), out: helper.text() })
    );
  } finally {
    helper.stop();
  }
});

check("process-adopt-current-process", "a process that adopted itself takes its whole descendant tree with it when it is killed", async (ctx) => {
  const { platform, log } = ctx;
  // The harness case (#25): the harness spawns a launcher that spawns the app that spawns mpv. A kill-on-close group
  // joined AFTER a spawn misses what that child already started, so the harness adopts ITSELF before spawning, and
  // every descendant is a member from creation. The helper adopts, spawns a mid process, which spawns a grandchild;
  // the helper is SIGKILLed; the grandchild (not a direct child, never assigned by anyone) must die.
  const heartbeat = writeScript(ctx, "heartbeat-adopt.mjs", HEARTBEAT);
  const mid = writeScript(ctx, "adopt-mid.mjs", TREE(heartbeat));
  const adopter = writeScript(
    ctx,
    "adopt-parent.mjs",
    `
import { spawn } from "node:child_process";
const { platform } = await import(${JSON.stringify(ctx.platformModule)});
const adopted = await platform.processes.childLifetime.adoptCurrentProcess();
console.log("adopted " + adopted);
if (!adopted) setInterval(() => {}, 1000);
else {
  spawn(process.execPath, [${JSON.stringify(mid)}], { stdio: ["ignore", "inherit", "inherit"] });
  setInterval(() => {}, 1000);
}
`
  );
  const helper = spawnHelper(ctx, adopter);
  try {
    await waitFor(() => helper.lines().some((line) => line.startsWith("adopted ")), 30_000, "the helper to report whether it adopted itself", helper.text);
    const adopted = helper.lines().find((line) => line.startsWith("adopted "))!.endsWith("true");
    if (!adopted) {
      // Windows is the OS whose guarantee this is: a refusal there is a failure, not a skip.
      assert(platform.id !== "windows", "adoptCurrentProcess() succeeds on Windows", helper.text());
      return `adoptCurrentProcess() is false on ${platform.id}: its per-child mechanism (wrap) covers this, checked by process-child-lifetime`;
    }
    await waitFor(() => helper.lines().some((line) => line.startsWith("grandchild ")), 20_000, "the mid process to report its child", helper.text);
    const grandchild = Number(helper.lines().find((line) => line.startsWith("grandchild "))!.split(" ")[1]);
    assert(pidAlive(grandchild), "the grandchild runs while the adopter lives", { grandchild });
    process.kill(helper.child.pid!, "SIGKILL");
    log(`process-adopt-current-process: killed adopter ${helper.child.pid}, waiting for grandchild ${grandchild}`);
    await waitFor(
      () => !pidAlive(grandchild) || platform.processes.readCommandLineSync(grandchild) === null,
      10_000,
      "the grandchild to die with the adopter",
      () => ({ grandchild, commandLine: platform.processes.readCommandLineSync(grandchild), out: helper.text() })
    );
  } finally {
    helper.stop();
  }
});

check("process-no-inherited-sockets", "spawned children inherit no parent listening sockets", async (ctx) => {
  const { platform, log } = ctx;
  // Chromium's DevTools listener (Electron `--remote-debugging-port`) has no
  // CLOEXEC, and neither libuv nor Node closes fds above 2 when it spawns, so
  // the runtime and mpv used to keep that port bound after Electron let go.
  // The harness cannot create that exact leak: bun and node both mark or close
  // foreign fds themselves, and neither can hand a listening Server to a
  // child. It stands in for the leaking parent instead: it opens a handle and
  // passes it at stdio index 3, which on an OS with fd inheritance gives the
  // child the same non-CLOEXEC descriptor Chromium's spawn leaves behind. The
  // child gets the handle ONLY because its parent leaked it, so a launcher
  // that isolates its child must close it before the program runs.
  //
  // Two phases per launcher, because a launcher may isolate in two ways:
  //  - direct: spawn the launcher's argv with the handle at stdio 3. Only
  //    meaningful when the launcher rewrote argv (it closes the handle itself).
  //    An OS where handles are passed explicitly and never implicitly (Windows)
  //    returns argv unchanged, and the handle would reach the child by design.
  //  - chain: a helper holding the handle at stdio 3 spawns the child the way
  //    production does (launcher argv + spawnOptions, default stdio table).
  //    The child must not see the helper's handle: this is what proves the
  //    default spawn passes nothing beyond its stdio table.
  const token = `sf-inherited-${process.pid}-${Date.now()}`;
  const handlePath = join(ctx.tmp, "inherited-handle.txt");
  writeFileSync(handlePath, token, "utf8");
  const probe = writeScript(
    ctx,
    "inherited-probe.mjs",
    `
import { readSync } from "node:fs";
const token = ${JSON.stringify(token)};
const held = [];
for (let fd = 3; fd < 64; fd++) {
  const buffer = Buffer.alloc(token.length);
  try {
    if (readSync(fd, buffer, 0, buffer.length, 0) === buffer.length && buffer.toString("utf8") === token) held.push(fd);
  } catch {
    // not an open readable handle: nothing inherited at this index
  }
}
console.log("held " + (held.length > 0 ? held.join(",") : "none"));
`
  );
  const spawnOptions = platform.processes.spawnOptions({ detached: false });
  // The chain helper builds the argv itself: `wrap`'s argv must be spawned by the process that wrapped it.
  const launchers = [
    ["withoutInheritedHandles", platform.processes.withoutInheritedHandles, "platform.processes.withoutInheritedHandles"],
    ["childLifetime.wrap", platform.processes.childLifetime.wrap, "platform.processes.childLifetime.wrap"],
  ] as const;
  const runWithHandle = async (name: string, command: string, args: string[], state: object): Promise<void> => {
    const handle = openSync(handlePath, "r");
    let output = "";
    try {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe", handle], ...spawnOptions });
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
      });
      const code = await new Promise<number | null>((resolve) => child.on("close", (c) => resolve(c)));
      log(`process-no-inherited-sockets: ${name} -> ${output.trim()} (exit ${code})`);
      assert(code === 0, `${name}: the launched child still runs and exits 0`, { ...state, code, output });
      assert(/(^|\n)held none\s*$/.test(output), `${name}: the child holds no handle its parent leaked to it`, { ...state, output });
    } finally {
      closeSync(handle);
    }
  };
  for (const [name, launch, launchExpression] of launchers) {
    const argv = await launch(bunExecutable(), [probe], {});
    if (argv.command !== bunExecutable() || argv.args.length !== 1 || argv.args[0] !== probe) {
      await runWithHandle(`${name} (direct)`, argv.command, argv.args, { argv });
    } else {
      log(`process-no-inherited-sockets: ${name} leaves argv unchanged, chain phase only`);
    }
    const chain = writeScript(
      ctx,
      "inherited-chain.mjs",
      `
import { spawn } from "node:child_process";
const { platform } = await import(${JSON.stringify(ctx.platformModule)});
const argv = await ${launchExpression}(${JSON.stringify(bunExecutable())}, [${JSON.stringify(probe)}], {});
const options = ${JSON.stringify(spawnOptions)};
const child = spawn(argv.command, argv.args, { stdio: ["ignore", "pipe", "inherit"], ...options });
child.stdout.pipe(process.stdout);
// "close", not "exit", and exitCode, not process.exit(): either shortcut can drop the probe's
// piped line under load (exit fires before stdout drains; process.exit cuts pending writes).
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
`
    );
    await runWithHandle(`${name} (chain)`, bunExecutable(), [chain], { argv });
  }
});

check("hardware-encoders", "encoder policy is coherent and selection follows it", async ({ platform }) => {
  const policy = platform.hardware.encoderPolicy;
  assert(policy.order.length > 0, "the OS lists at least one hardware encoder", policy);
  for (const key of Object.keys(policy.vendors)) {
    assert(policy.order.includes(key as HardwareEncoder), `vendor entry ${key} is a listed encoder`, policy);
  }
  assert(pickHardwareEncoder(policy, [], "intel") === null, "nothing advertised -> software");
  assert(pickHardwareEncoder(policy, policy.order, "") === policy.order[0], "no vendor -> first of the OS order", policy);
  for (const encoder of policy.order) {
    for (const needle of policy.vendors[encoder] ?? []) {
      const firstForVendor = policy.order.find((candidate) => policy.vendors[candidate]?.includes(needle));
      assert(pickHardwareEncoder(policy, policy.order, needle) === firstForVendor, `vendor ${needle} -> first encoder listing it (${firstForVendor})`, policy);
      assert(pickHardwareEncoder(policy, [encoder], "some other vendor") === encoder, "a lone advertised encoder is used", policy);
    }
  }
  const names = policy.order.map((encoder) => `h264_${encoder}`);
  assert(advertisedHardwareEncoders(policy, [...names, "libx264"]).length === policy.order.length, "advertised listing keeps only OS encoders");
  assert(advertisedHardwareEncoders(policy, ["h264_unknown_gpu"]).length === 0, "foreign encoders are ignored");
});

check("hardware-host", "GPU vendor, devices, memory limit, CPU limits and pressure never throw and have sane shapes", async ({ platform }) => {
  const vendor = await platform.hardware.detectGpuVendor();
  assert(typeof vendor === "string" && vendor === vendor.toLowerCase(), "detectGpuVendor is a lower-case string", vendor);
  for (const encoder of platform.hardware.encoderPolicy.order) {
    const device = platform.hardware.deviceFor(encoder, {});
    assert(device === null || (typeof device === "string" && device.length > 0), `deviceFor(${encoder})`, device);
  }
  const memory = platform.hardware.memoryLimitBytes();
  assert(memory === null || (Number.isFinite(memory) && memory > 0), "memoryLimitBytes is null or positive", memory);
  const stack = platform.hardware.graphicsStack();
  assert(stack === null || (typeof stack === "string" && stack.length > 0), "graphicsStack is null or a non-empty string", stack);
  const limits = platform.hardware.readCpuLimits();
  assert(limits.affinityCount === null || (Number.isInteger(limits.affinityCount) && limits.affinityCount >= 1), "affinityCount", limits);
  assert(limits.quota === null || limits.quota.cpus > 0, "quota", limits);
  assert(Array.isArray(limits.checked), "checked list", limits);
  const reader = platform.hardware.createCpuPressureReader();
  if (reader !== null) {
    const sample = reader();
    assert(sample === null || (sample.some >= 0 && sample.some <= 1), "pressure sample in 0..1", sample);
  }
});

check("diagnostics", "process and port diagnostics are best-effort objects that name the platform", async ({ platform }) => {
  const proc = await platform.diagnostics.readProcess(process.pid);
  assert(typeof proc.platform === "string", "readProcess has platform", proc);
  const dead = await platform.diagnostics.readProcess(2 ** 22 - 7);
  assert(typeof dead.platform === "string", "readProcess of a dead pid still names the platform", dead);
  const port = await platform.diagnostics.readPortHolders(1);
  assert(typeof port.platform === "string", "readPortHolders has platform", port);
});

check("shell", "shell hooks configure the app and report display availability", async ({ platform, tmp }) => {
  const calls: string[] = [];
  platform.shell.prepareApp(
    {
      setAppUserModelId: (id) => calls.push(`aumid:${id}`),
      commandLine: { appendSwitch: (name, value) => calls.push(`switch:${name}${value === undefined ? "" : `=${value}`}`) },
    },
    { appUserModelId: "io.example.app", linuxWindowClass: "ExampleClass" }
  );
  if (platform.id === "windows") assert(calls.includes("aumid:io.example.app"), "Windows sets the AppUserModelId", calls);
  if (platform.id === "linux") assert(calls.includes("switch:class=ExampleClass"), "Linux sets the WM class", calls);
  assert(typeof platform.shell.quitWhenAllWindowsClosed === "boolean", "quitWhenAllWindowsClosed");
  const appName = platform.shell.appName({ productName: "ExampleProduct", legacyName: "ExampleLegacy" });
  assert(appName === "ExampleProduct" || appName === "ExampleLegacy", "appName is the product or the legacy name", appName);
  assert(typeof platform.shell.applicationMenu === "boolean", "applicationMenu", platform.shell.applicationMenu);
  assert(["color", "template"].includes(platform.shell.trayIcon), "trayIcon is color | template", platform.shell.trayIcon);
  const userData = platform.paths.appUserDataDir({ appData: tmp, productName: "ExampleProduct", legacyDir: ["@ex", "legacy"] });
  assert(userData.startsWith(tmp) && userData.length > tmp.length, "appUserDataDir is below appData", userData);
  assert(platform.shell.hasDisplay({ DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }) === true, "a display env means a display");
  if (platform.id !== "linux") assert(platform.shell.hasDisplay({}) === true, "desktop OSes always have a display");
  const window = platform.shell.mpvWindow({ appId: "io.example.app", env: { DISPLAY: ":0" } });
  assert(window.defaultVo.length > 0 && Array.isArray(window.args), "mpvWindow names a default vo and an args list", window);
  assert(Array.isArray(window.unsetEnv), "mpvWindow lists the variables to take out of mpv's environment", window);
  assert(
    window.cpuVo === null || (window.cpuVo.length > 0 && window.defaultVo.split(",").includes(window.cpuVo)),
    "mpvWindow's CPU vo is null or the CPU entry of the default vo list",
    window
  );
  const mpvEnv = { KEEP: "1" };
  const prepared = platform.shell.prepareMpvWindow({ appId: "io.example.app", dataDir: "/nonexistent-conformance-dir", env: mpvEnv });
  assert(prepared !== mpvEnv && prepared.KEEP === "1", "prepareMpvWindow returns a copy that keeps the environment", prepared);
});

export const conformanceChecks: readonly ConformanceCheck[] = checks;

export const createConformanceContext = (platform: DesktopPlatform, platformModule: string, log: (line: string) => void = () => {}): ConformanceContext => ({
  platform,
  platformModule,
  tmp: mkdtempSync(join(tmpdir(), "sf-platform-conformance-")),
  log,
});

export const disposeConformanceContext = (ctx: ConformanceContext) => {
  rmSync(ctx.tmp, { recursive: true, force: true });
};

/** Run every check; never throws. */
export const runConformance = async (
  platform: DesktopPlatform,
  platformModule: string,
  options: { log?: (line: string) => void; only?: readonly string[] } = {}
): Promise<ConformanceResult[]> => {
  const ctx = createConformanceContext(platform, platformModule, options.log);
  const results: ConformanceResult[] = [];
  try {
    for (const item of checks) {
      if (options.only && !options.only.includes(item.id)) continue;
      const startedAt = Date.now();
      try {
        const skipped = await item.run(ctx);
        results.push({ id: item.id, title: item.title, status: skipped ? "skipped" : "ok", detail: skipped || undefined, ms: Date.now() - startedAt });
      } catch (error) {
        results.push({
          id: item.id,
          title: item.title,
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
          ms: Date.now() - startedAt,
        });
      }
    }
  } finally {
    disposeConformanceContext(ctx);
  }
  return results;
};

/** TAP 13 for a result list, plus a header naming the platform under test. */
export const formatTap = (platform: DesktopPlatform, results: readonly ConformanceResult[]): string => {
  const lines = [`TAP version 13`, `# desktop platform conformance: ${platform.id}-${platform.arch}`, `1..${results.length}`];
  results.forEach((result, index) => {
    const prefix = result.status === "failed" ? "not ok" : "ok";
    const directive = result.status === "skipped" ? ` # SKIP ${result.detail ?? ""}` : "";
    lines.push(`${prefix} ${index + 1} - ${result.id}: ${result.title} (${result.ms} ms)${directive}`);
    if (result.status === "failed" && result.detail) {
      for (const detailLine of result.detail.split("\n")) lines.push(`  # ${detailLine}`);
    }
  });
  const failed = results.filter((result) => result.status === "failed").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  lines.push(`# ${results.length - failed - skipped} passed, ${skipped} skipped, ${failed} failed`);
  return lines.join("\n");
};
