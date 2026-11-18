/**
 * Linux ProcessLayer. Cases moved with their logic from the call sites:
 *   - process-group liveness (apps/badger/desktop mpv-socket-client-hung-mpv-kill.test.ts, issue #25 P21)
 *   - thread ids (packages/ffmpeg resourcePolicy), parent-death wrapper (packages/ffmpeg index.ts, #25 P7)
 *   - command line (packages/ingest-core encoderLease.ts, packages/runtime-host guardian.ts)
 *   - process control (the playback gate's Linux backend): see processControl.test.ts
 * Real processes where the point is real signals / a real /proc; a fake procfs where the point is a decision.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLinuxProcessGroup } from "../src/processGroup";
import { createLinuxProcesses, linuxProcesses } from "../src/processes";

const TAG = "[linux-processes]";

const tmpDirs: string[] = [];
const children: ChildProcess[] = [];
const makeTmp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The setpriv the layer itself would find (the test process's PATH); throws rather than letting a shim re-exec itself. */
const findSetpriv = (): string => {
  const found = [...(process.env.PATH ?? "").split(":"), "/usr/bin", "/bin"].map((dir) => join(dir, "setpriv")).find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`${TAG} no setpriv on PATH`);
  return found;
};

const procState = (pid: number): string | null => {
  try {
    return /\) (\S) /.exec(readFileSync(`/proc/${pid}/stat`, "utf8"))?.[1] ?? null;
  } catch {
    return null;
  }
};

/** Polls the real /proc until `predicate` holds; the failure names what was awaited. */
const waitUntil = (label: string, predicate: () => boolean, timeout: number): Promise<void> =>
  vi.waitFor(
    () => {
      if (!predicate()) throw new Error(`${TAG} still waiting for ${label}`);
    },
    { timeout, interval: 25 }
  );

describe.skipIf(process.platform !== "linux")("linux process group (issue #25 P21)", () => {
  // Read lazily: describe bodies run even when skipped, and /proc is Linux-only.
  let ownPgid = 0;
  beforeAll(() => {
    ownPgid = Number(readFileSync("/proc/self/stat", "utf8").split(") ")[1]?.split(" ")[2]);
  });

  const writeFakeProc = (members: Array<{ pid: number; comm: string; state: string; pgrp: number }>): string => {
    const root = makeTmp("sf-fake-proc-");
    for (const { pid, comm, state, pgrp } of members) {
      mkdirSync(join(root, String(pid)));
      writeFileSync(join(root, String(pid), "stat"), `${pid} (${comm}) ${state} 1 ${pgrp} ${pgrp} 0 -1 4194560 0 0`);
    }
    mkdirSync(join(root, "self"));
    console.info(`${TAG} fake /proc ${root} ownPgid=${ownPgid} members=${JSON.stringify(members)}`);
    return root;
  };

  /**
   * CI regression (PR #111, desktop-test run 8208): nothing reaps orphans in
   * the CI container, so a killed mpv child stayed a zombie. `kill(-pgid, 0)`
   * still succeeds on a zombie-only group, so a `kill(-pgid, 0)`-only probe
   * answers "alive" for this test's own REAL group (red before the fix).
   */
  it("@bugfix @regression-proof a group whose only members are zombies is dead", () => {
    expect(Number.isInteger(ownPgid) && ownPgid > 0).toBe(true);
    const root = writeFakeProc([
      { pid: 41001, comm: "mpv", state: "Z", pgrp: ownPgid },
      { pid: 41002, comm: "AppRun", state: "Z", pgrp: ownPgid },
      { pid: 41003, comm: "unrelated", state: "S", pgrp: ownPgid + 1 },
    ]);
    const alive = createLinuxProcessGroup(root).isAlive(ownPgid);
    console.info(`${TAG} zombie-only group alive=${alive}`);
    expect(alive).toBe(false);
  });

  it("a group with one running or stopped member is alive, even when comm holds spaces and parens", () => {
    const root = writeFakeProc([
      { pid: 41001, comm: "mpv", state: "Z", pgrp: ownPgid },
      { pid: 41002, comm: "ld-linux (x) 2", state: "T", pgrp: ownPgid },
    ]);
    const alive = createLinuxProcessGroup(root).isAlive(ownPgid);
    console.info(`${TAG} group with stopped member alive=${alive}`);
    expect(alive).toBe(true);
  });

  it("the real /proc reports this test's own group alive", () => {
    const alive = linuxProcesses.group.isAlive(ownPgid);
    console.info(`${TAG} own group alive=${alive}`);
    expect(alive).toBe(true);
  });

  it("an unreadable procfs falls back to the kill(-pgid, 0) probe", () => {
    const missing = join(makeTmp("sf-fake-proc-"), "does-not-exist");
    expect(createLinuxProcessGroup(missing).isAlive(ownPgid)).toBe(true);
    expect(createLinuxProcessGroup(missing).isAlive(2 ** 22 - 11)).toBe(false);
  });

  it("terminate wakes a stopped member, kill takes the whole group down, a dead group is not an error", async () => {
    // `/bin/sh` is the group leader (the wrapper); its child stops itself, like a hung mpv core.
    const leader = spawn("/bin/sh", ["-c", "sleep 300 & sleep 300 & kill -STOP $$ ; wait"], {
      stdio: "ignore",
      ...linuxProcesses.spawnOptions({ detached: true }),
    });
    children.push(leader);
    const pgid = leader.pid!;
    await waitUntil("the leader to stop itself", () => procState(pgid) === "T", 5000);
    console.info(`${TAG} leader=${pgid} state=${procState(pgid)} alive=${linuxProcesses.group.isAlive(pgid)}`);
    expect(linuxProcesses.group.isAlive(pgid)).toBe(true);

    expect(linuxProcesses.group.signal(pgid, "terminate")).toBe(true);
    await waitUntil("the group to die on terminate", () => !linuxProcesses.group.isAlive(pgid), 5000);

    // Signalling a group that is dead must not throw. An unreaped zombie member still takes kill(-pgid), so
    // the strict "delivered to nobody" answer is only checked for a group that never existed.
    expect(typeof linuxProcesses.group.signal(pgid, "kill")).toBe("boolean");
    expect(linuxProcesses.group.signal(2 ** 22 - 11, "kill")).toBe(false);
    expect(linuxProcesses.group.signal(2 ** 22 - 11, "terminate")).toBe(false);
  });
});

describe.skipIf(process.platform !== "linux")("linux thread ids", () => {
  it("lists every kernel thread of a process", () => {
    const ids = linuxProcesses.listThreadIds(process.pid);
    console.info(`${TAG} own threads=${JSON.stringify(ids)}`);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    expect(ids).toContain(process.pid);
  });

  it("reads <procRoot>/<pid>/task, ignoring non-numeric entries", () => {
    const root = makeTmp("sf-fake-proc-");
    for (const tid of ["500", "501", "502", "not-a-tid"]) mkdirSync(join(root, "500", "task", tid), { recursive: true });
    expect(createLinuxProcesses({ procRoot: root }).listThreadIds(500).sort()).toEqual([500, 501, 502]);
  });

  it("falls back to [pid] when the process is gone or has no task entries", () => {
    const root = makeTmp("sf-fake-proc-");
    mkdirSync(join(root, "600", "task"), { recursive: true });
    const layer = createLinuxProcesses({ procRoot: root });
    expect(layer.listThreadIds(600)).toEqual([600]);
    expect(layer.listThreadIds(601)).toEqual([601]);
  });
});

describe.skipIf(process.platform !== "linux")("linux command line", () => {
  const fakeCmdline = (pid: number, raw: string): string => {
    const root = makeTmp("sf-fake-proc-");
    mkdirSync(join(root, String(pid)));
    writeFileSync(join(root, String(pid), "cmdline"), raw);
    return root;
  };

  it("joins argv with spaces and trims the trailing NUL", async () => {
    const layer = createLinuxProcesses({ procRoot: fakeCmdline(700, "/usr/bin/bun\0src/index.ts\0--port\x008080\0") });
    expect(layer.readCommandLineSync(700)).toBe("/usr/bin/bun src/index.ts --port 8080");
    await expect(layer.readCommandLine(700)).resolves.toBe("/usr/bin/bun src/index.ts --port 8080");
  });

  it("is null for an empty cmdline (zombie / kernel thread) and for an unknown pid", async () => {
    const layer = createLinuxProcesses({ procRoot: fakeCmdline(701, "") });
    expect(layer.readCommandLineSync(701)).toBeNull();
    await expect(layer.readCommandLine(701)).resolves.toBeNull();
    expect(layer.readCommandLineSync(702)).toBeNull();
    await expect(layer.readCommandLine(702)).resolves.toBeNull();
  });

  it("reads a real process's command line from the real /proc", async () => {
    const marker = `sf-linux-cmdline-${process.pid}-${Date.now()}`;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], { stdio: "ignore" });
    children.push(child);
    await waitUntil("the child's command line", () => linuxProcesses.readCommandLineSync(child.pid!)?.includes(marker) === true, 5000);
    await expect(linuxProcesses.readCommandLine(child.pid!)).resolves.toContain(marker);
    expect(await linuxProcesses.readCommandLine(2 ** 22 - 7)).toBeNull();
  });
});

describe.skipIf(process.platform !== "linux")("linux pid namespace and spawn options", () => {
  it("ownPidNamespace is the inode of /proc/self/ns/pid", () => {
    const ns = linuxProcesses.ownPidNamespace();
    const raw = readlinkOrNull("/proc/self/ns/pid");
    console.info(`${TAG} own pid namespace=${ns} link=${raw}`);
    if (raw === null) expect(ns).toBeNull();
    else expect(ns).toBe(/^pid:\[(\d+)\]$/.exec(raw)?.[1]);
  });

  it("parses `pid:[N]` and is null when the link is unreadable or malformed", () => {
    const root = makeTmp("sf-fake-proc-");
    mkdirSync(join(root, "self", "ns"), { recursive: true });
    symlinkSync("pid:[4026531836]", join(root, "self", "ns", "pid"));
    expect(createLinuxProcesses({ procRoot: root }).ownPidNamespace()).toBe("4026531836");

    const odd = makeTmp("sf-fake-proc-");
    mkdirSync(join(odd, "self", "ns"), { recursive: true });
    symlinkSync("net:[1]", join(odd, "self", "ns", "pid"));
    expect(createLinuxProcesses({ procRoot: odd }).ownPidNamespace()).toBeNull();
    expect(createLinuxProcesses({ procRoot: join(odd, "missing") }).ownPidNamespace()).toBeNull();
  });

  it("spawnOptions only carries `detached` (Linux needs no windowsHide)", () => {
    expect(linuxProcesses.spawnOptions({ detached: true })).toEqual({ detached: true });
    expect(linuxProcesses.spawnOptions({ detached: false })).toEqual({ detached: false });
  });
});

const readlinkOrNull = (path: string): string | null => {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
};

describe.skipIf(process.platform !== "linux")("linux childLifetime (parent-death wrapper, #25 P7)", () => {
  type Probe = { setpriv: string; args: string[] };

  const fakeSetpriv = (): string => {
    const dir = makeTmp("sf-fake-bin-");
    const path = join(dir, "setpriv");
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
    return dir;
  };

  const makeLayer = (options: { pathEnv: string; probeOk?: boolean }) => {
    const probes: Probe[] = [];
    const logs: Array<{ level: string; event: Record<string, unknown> }> = [];
    const layer = createLinuxProcesses({
      pathEnv: options.pathEnv,
      runSetpriv: async (setpriv, args) => {
        probes.push({ setpriv, args });
        return options.probeOk ?? true;
      },
      log: (level, event) => logs.push({ level, event }),
    });
    return { layer, probes, logs };
  };

  it("wraps a resolvable command in `setpriv --pdeathsig KILL --` (outermost, so the signal is armed before the fd-closing prelude runs) with its absolute path, probing once", async () => {
    const dir = fakeSetpriv();
    const { layer, probes, logs } = makeLayer({ pathEnv: dir });
    const first = await layer.childLifetime.wrap("sh", ["-c", "true"], { PATH: "/bin:/usr/bin" });
    const second = await layer.childLifetime.wrap("sh", ["-c", "true"], { PATH: "/bin:/usr/bin" });
    console.info(`${TAG} wrapped=${JSON.stringify(first)} probes=${JSON.stringify(probes)} logs=${JSON.stringify(logs)}`);
    expect(first.command).toBe(join(dir, "setpriv"));
    expect(first.args.slice(0, 3)).toEqual(["--pdeathsig", "KILL", "--"]);
    expect(first.args[3]).toMatch(/\/(sh|bash)$/);
    expect(first.args.slice(4, 6)).toEqual(["--posix", "-c"]);
    expect(first.args[6]).toContain('[ "$PPID" = "$1" ] || exit 1');
    expect(first.args[8]).toBe(String(process.pid));
    expect(first.args[9]).toMatch(/\/sh$/);
    expect(first.args.slice(10)).toEqual(["-c", "true"]);
    expect(second).toEqual(first);
    expect(probes).toEqual([{ setpriv: join(dir, "setpriv"), args: ["--pdeathsig", "KILL", "--", "true"] }]);
    expect(logs).toEqual([{ level: "info", event: { event: "ffmpeg.parent_death_signal", mode: "setpriv", setpriv: join(dir, "setpriv") } }]);
    await expect(layer.childLifetime.supported()).resolves.toBe(true);
  });

  it("returns an unresolvable command unwrapped so the spawn still fails with ENOENT", async () => {
    const { layer } = makeLayer({ pathEnv: fakeSetpriv() });
    const wrapped = await layer.childLifetime.wrap("sf-no-such-binary-xyz", ["a"], { PATH: "/bin" });
    expect(wrapped).toEqual({ command: "sf-no-such-binary-xyz", args: ["a"] });
  });

  it("without pdeathsig the command still runs behind the fd-closing prelude and setpriv's rejection is warned once", async () => {
    const { layer, logs } = makeLayer({ pathEnv: fakeSetpriv(), probeOk: false });
    const a = await layer.childLifetime.wrap("sh", ["-c", "true"]);
    await layer.childLifetime.wrap("sh", ["-c", "true"]);
    expect(a.command).toMatch(/\/(sh|bash)$/);
    expect(a.args.slice(4)).toEqual([expect.stringMatching(/\/sh$/), "-c", "true"]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: "warn", event: { mode: "none", reason: "setpriv-rejected-pdeathsig" } });
    await expect(layer.childLifetime.supported()).resolves.toBe(false);
  });

  // @bugfix @regression-proof: setpriv arms PR_SET_PDEATHSIG only once it runs, so a parent that dies between the
  // fork and that prctl left an orphan nothing would ever kill (157 of 300 immediate-SIGKILL spawns survived).
  // A setpriv that starts late makes the window wide and the outcome deterministic.
  it("a wrapped child whose parent dies before setpriv arms the death signal exits without running the program", async () => {
    if (!(await linuxProcesses.childLifetime.supported())) {
      console.info(`${TAG} setpriv --pdeathsig unsupported on this host: skipping the late-arming check`);
      return;
    }
    const dir = makeTmp("sf-pdeath-late-");
    const shimDir = join(dir, "bin");
    mkdirSync(shimDir);
    const shim = join(shimDir, "setpriv");
    writeFileSync(shim, `#!/bin/sh\nsleep 0.4\nexec ${findSetpriv()} "$@"\n`);
    chmodSync(shim, 0o755);
    const marker = join(dir, "program-ran");
    const parentScript = join(dir, "parent.mjs");
    writeFileSync(
      parentScript,
      `import { spawn } from "node:child_process";
import { linuxProcesses } from ${JSON.stringify(join(import.meta.dirname, "../src/processes.ts"))};
const wrapped = await linuxProcesses.childLifetime.wrap("sh", ["-c", "echo ran > " + ${JSON.stringify(marker)} + "; sleep 30"], {});
const child = spawn(wrapped.command, wrapped.args, { stdio: "ignore" });
console.log("child " + child.pid);
setInterval(() => {}, 1000);
`
    );
    const parent = spawn("bun", [parentScript], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` } });
    children.push(parent);
    let out = "";
    parent.stdout!.on("data", (chunk) => (out += String(chunk)));
    await waitUntil("the parent to print the child pid", () => /child \d+/.test(out), 15_000);
    const childPid = Number(/child (\d+)/.exec(out)![1]);
    parent.kill("SIGKILL");
    await waitUntil("the orphaned child to exit instead of running the program", () => {
      const state = procState(childPid);
      return state === null || state === "Z";
    }, 10_000);
    expect(existsSync(marker)).toBe(false);
    console.info(`${TAG} child ${childPid} refused to run behind a dead parent`);
  }, 40_000);

  it("afterSpawn is a no-op on Linux", () => {
    expect(linuxProcesses.childLifetime.afterSpawn(process.pid)).toBeUndefined();
    expect(linuxProcesses.childLifetime.afterSpawn(undefined)).toBeUndefined();
  });

  it("a real wrapped child dies when its parent is SIGKILLed", async () => {
    if (!(await linuxProcesses.childLifetime.supported())) {
      console.info(`${TAG} setpriv --pdeathsig unsupported on this host: skipping the real-child check`);
      return;
    }
    const dir = makeTmp("sf-pdeath-");
    const parentScript = join(dir, "parent.mjs");
    const modulePath = join(import.meta.dirname, "../src/processes.ts");
    writeFileSync(
      parentScript,
      `import { spawn } from "node:child_process";
import { linuxProcesses } from ${JSON.stringify(modulePath)};
const wrapped = await linuxProcesses.childLifetime.wrap(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {});
const child = spawn(wrapped.command, wrapped.args, { stdio: "ignore" });
linuxProcesses.childLifetime.afterSpawn(child.pid);
console.log("child " + child.pid);
setInterval(() => {}, 1000);
`
    );
    const parent = spawn("bun", [parentScript], { stdio: ["ignore", "pipe", "pipe"] });
    children.push(parent);
    let out = "";
    parent.stdout!.on("data", (chunk) => (out += String(chunk)));
    await waitUntil("the parent to print the child pid", () => /child \d+/.test(out), 15_000);
    const childPid = Number(/child (\d+)/.exec(out)![1]);
    expect(procState(childPid)).not.toBeNull();
    parent.kill("SIGKILL");
    await waitUntil("the child to die with its parent", () => {
      const state = procState(childPid);
      return state === null || state === "Z";
    }, 10_000);
    console.info(`${TAG} child ${childPid} died with its parent (state=${procState(childPid)})`);
  });
});

describe.skipIf(process.platform !== "linux")("linux inherited fds (@bugfix @regression-proof: Electron's DevTools port stayed bound by the runtime and mpv)", () => {
  const LEAKED_FD = 68;

  /**
   * Stands in for Electron's main process: bash opens `LEAKED_FD` with no
   * CLOEXEC and execs the argv, exactly what libuv does with Chromium's
   * listening socket (the real one was fd 68 on :9333). Resolves the pid, which
   * after the execs is the final program's.
   */
  const spawnFromLeakyParent = async (handlePath: string, argv: { command: string; args: string[] }, env: NodeJS.ProcessEnv = process.env): Promise<number> => {
    const leaky = spawn("bash", ["-c", `exec ${LEAKED_FD}<"$1"; shift; exec "$@"`, "sf-leaky-parent", handlePath, argv.command, ...argv.args], {
      stdio: "ignore",
      env,
    });
    children.push(leaky);
    const pid = leaky.pid!;
    await waitUntil("the leaky parent to exec the program", () => /^(\/\S*\/)?sleep 30$/.test(linuxProcesses.readCommandLineSync(pid) ?? ""), 10_000);
    // exec swaps the command line before it drops the old image's close-on-exec fds
    await waitUntil("the exec to finish dropping its close-on-exec fds", () => Object.values(openFds(pid)).every((target) => target !== null), 5_000);
    return pid;
  };

  const openFds = (pid: number): Record<string, string | null> =>
    Object.fromEntries(readdirSync(`/proc/${pid}/fd`).map((fd) => [fd, readlinkOrNull(`/proc/${pid}/fd/${fd}`)]));

  const makeHandle = (): string => {
    const path = join(makeTmp("sf-fd-handle-"), "listener-stand-in");
    writeFileSync(path, "x");
    return path;
  };

  it("control: spawning straight from the leaky parent leaves the fd in the child", async () => {
    const handle = makeHandle();
    const pid = await spawnFromLeakyParent(handle, { command: "sleep", args: ["30"] });
    console.info(`${TAG} unwrapped child ${pid} fds=${JSON.stringify(openFds(pid))}`);
    expect(openFds(pid)[LEAKED_FD]).toBe(handle);
  });

  it("withoutInheritedHandles closes every fd >= 3 and the program keeps its pid and command line", async () => {
    const handle = makeHandle();
    const argv = linuxProcesses.withoutInheritedHandles("sleep", ["30"]);
    expect(argv.command).toMatch(/\/(sh|bash)$/);
    const pid = await spawnFromLeakyParent(handle, argv);
    console.info(`${TAG} isolated child ${pid} fds=${JSON.stringify(openFds(pid))}`);
    expect(Object.keys(openFds(pid)).sort()).toEqual(["0", "1", "2"]);
    expect(linuxProcesses.readCommandLineSync(pid)).toMatch(/^\/.*\/sleep 30$/);
  });

  it("childLifetime.wrap closes them too, behind the parent-death signal", async () => {
    if (!(await linuxProcesses.childLifetime.supported())) {
      console.info(`${TAG} setpriv --pdeathsig unsupported on this host: skipping`);
      return;
    }
    const handle = makeHandle();
    const argv = await linuxProcesses.childLifetime.wrap("sleep", ["30"]);
    const pid = await spawnFromLeakyParent(handle, argv);
    expect(Object.keys(openFds(pid)).sort()).toEqual(["0", "1", "2"]);
    expect(linuxProcesses.readCommandLineSync(pid)).toMatch(/^\/.*\/sleep 30$/);
  });

  it("keeps stdio and argv intact (spaces, `$`) and does not run the caller's $BASH_ENV", async () => {
    const dir = makeTmp("sf-bash-env-");
    const marker = join(dir, "bash-env-ran");
    const bashEnv = join(dir, "bash-env.sh");
    writeFileSync(bashEnv, `touch ${JSON.stringify(marker)}\n`);
    const env = { ...process.env, BASH_ENV: bashEnv };
    const argv = linuxProcesses.withoutInheritedHandles("sh", ["-c", 'printf "%s|" "$@"; echo err >&2', "x", "a b", "$HOME"], env);
    const child = spawn(argv.command, argv.args, { stdio: ["ignore", "pipe", "pipe"], env });
    children.push(child);
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    // 'close', not 'exit': 'exit' can fire before the piped stdout/stderr are drained, which
    // read as `out: ''` on a loaded runner (staging push run 11750).
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect({ code, out, err }).toEqual({ code: 0, out: "a b|$HOME|", err: "err\n" });
    expect(() => readFileSync(marker)).toThrow();
  });

  it("returns a command that does not resolve unchanged so the spawn still fails with ENOENT", () => {
    expect(linuxProcesses.withoutInheritedHandles("sf-no-such-binary-xyz", ["a"], { PATH: "/bin" })).toEqual({
      command: "sf-no-such-binary-xyz",
      args: ["a"],
    });
  });
});
