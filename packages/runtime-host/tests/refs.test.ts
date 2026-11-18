import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { getLivePids, readPidsFromFile, readRuntimePid, registerPid, unregisterPid, writeRuntimePid } from "../src/refs";

const SUITE = "runtime-host-refs";

type RefOp =
  | { op: "register"; pid: number; resultPids: number[] }
  | { op: "unregister"; pid: number; resultPids: number[] }
  | { op: "read"; resultPids: number[] }
  | { op: "live"; resultPids: number[] }
  | { op: "writePid"; pidPath: string; pid: number }
  | { op: "readPid"; pidPath: string; result: number | null };

const dumpRefsSnapshot = (
  label: string,
  ctx: {
    root?: string;
    refsPath?: string;
    pidPath?: string;
    ops?: RefOp[];
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [${SUITE}:${label}] snapshot ===`);
    console.error(`root: ${ctx.root ?? "(none)"}`);
    if (ctx.refsPath) {
      console.error(`refsPath: ${ctx.refsPath}`);
      console.error(`refsPath exists: ${existsSync(ctx.refsPath)}`);
      if (existsSync(ctx.refsPath)) {
        try {
          console.error(`refsPath body: ${JSON.stringify(readFileSync(ctx.refsPath, "utf8"))}`);
        } catch (e) {
          console.error(`(refs read failed: ${e instanceof Error ? e.message : String(e)})`);
        }
      }
      console.error(`readPidsFromFile: ${JSON.stringify(readPidsFromFile(ctx.refsPath))}`);
      console.error(`getLivePids: ${JSON.stringify(getLivePids(ctx.refsPath))}`);
    }
    if (ctx.pidPath) {
      console.error(`pidPath: ${ctx.pidPath}`);
      console.error(`pidPath exists: ${existsSync(ctx.pidPath)}`);
      console.error(`readRuntimePid: ${JSON.stringify(readRuntimePid(ctx.pidPath))}`);
    }
    if (ctx.ops) {
      console.error(`ref ops (recent):\n${JSON.stringify(ctx.ops, null, 2)}`);
    }
    if (ctx.extra) {
      console.error(`extra:\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("refs", () => {
  let root: string;
  let refsPath: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const setup = () => {
    root = mkdtempSync(joinPath(tmpdir(), "rt-refs-"));
    refsPath = joinPath(root, "runtime.refs");
    console.info(`[${SUITE}:setup] root=${root} refsPath=${refsPath}`);
  };

  it("registers a PID to an empty refs file", () => {
    setup();
    const ops: RefOp[] = [];
    console.info(`[${SUITE}:register-empty] registering pid=1234`);
    registerPid(refsPath, 1234);
    const pids = readPidsFromFile(refsPath);
    ops.push({ op: "register", pid: 1234, resultPids: pids });
    try {
      expect(pids).toEqual([1234]);
      console.info(`[${SUITE}:register-empty] OK pids=${JSON.stringify(pids)}`);
    } catch (err) {
      dumpRefsSnapshot("register-empty-failure", { root, refsPath, ops });
      throw err;
    }
  });

  it("does not duplicate PIDs on repeated registration", () => {
    setup();
    const ops: RefOp[] = [];
    console.info(`[${SUITE}:no-dup] registering pid=1234 twice`);
    registerPid(refsPath, 1234);
    ops.push({ op: "register", pid: 1234, resultPids: readPidsFromFile(refsPath) });
    registerPid(refsPath, 1234);
    const pids = readPidsFromFile(refsPath);
    ops.push({ op: "register", pid: 1234, resultPids: pids });
    try {
      expect(pids).toEqual([1234]);
      console.info(`[${SUITE}:no-dup] OK pids=${JSON.stringify(pids)}`);
    } catch (err) {
      dumpRefsSnapshot("no-dup-failure", { root, refsPath, ops });
      throw err;
    }
  });

  it("registers multiple distinct PIDs", () => {
    setup();
    const ops: RefOp[] = [];
    console.info(`[${SUITE}:multi-distinct] registering 1111 then 2222`);
    registerPid(refsPath, 1111);
    ops.push({ op: "register", pid: 1111, resultPids: readPidsFromFile(refsPath) });
    registerPid(refsPath, 2222);
    const pids = readPidsFromFile(refsPath);
    ops.push({ op: "register", pid: 2222, resultPids: pids });
    try {
      expect(pids).toEqual([1111, 2222]);
      console.info(`[${SUITE}:multi-distinct] OK pids=${JSON.stringify(pids)}`);
    } catch (err) {
      dumpRefsSnapshot("multi-distinct-failure", { root, refsPath, ops });
      throw err;
    }
  });

  it("unregisters a PID and returns remaining live PIDs", () => {
    setup();
    const ops: RefOp[] = [];
    const deadPid = 2_000_000_000;
    console.info(`[${SUITE}:unregister-prune] registering live pid=${process.pid} and dead pid=${deadPid}`);
    registerPid(refsPath, process.pid);
    ops.push({ op: "register", pid: process.pid, resultPids: readPidsFromFile(refsPath) });
    registerPid(refsPath, deadPid);
    ops.push({ op: "register", pid: deadPid, resultPids: readPidsFromFile(refsPath) });
    console.info(`[${SUITE}:unregister-prune] unregistering live pid=${process.pid}`);
    const remaining = unregisterPid(refsPath, process.pid);
    ops.push({ op: "unregister", pid: process.pid, resultPids: remaining });
    try {
      // dead PID is pruned
      expect(remaining).toEqual([]);
      console.info(`[${SUITE}:unregister-prune] OK remaining=${JSON.stringify(remaining)} (dead pid pruned)`);
    } catch (err) {
      dumpRefsSnapshot("unregister-prune-failure", { root, refsPath, ops, extra: { livePid: process.pid, deadPid } });
      throw err;
    }
  });

  it("returns empty for a missing refs file", () => {
    setup();
    console.info(`[${SUITE}:missing-file] reading refs without ever writing`);
    const fromFile = readPidsFromFile(refsPath);
    const live = getLivePids(refsPath);
    try {
      expect(fromFile).toEqual([]);
      expect(live).toEqual([]);
      console.info(`[${SUITE}:missing-file] OK both empty`);
    } catch (err) {
      dumpRefsSnapshot("missing-file-failure", {
        root,
        refsPath,
        ops: [
          { op: "read", resultPids: fromFile },
          { op: "live", resultPids: live },
        ],
      });
      throw err;
    }
  });

  it("getLivePids filters out dead PIDs", () => {
    setup();
    const ops: RefOp[] = [];
    const deadPid = 2_000_000_000;
    console.info(`[${SUITE}:live-filter] registering live pid=${process.pid} and dead pid=${deadPid}`);
    registerPid(refsPath, process.pid);
    ops.push({ op: "register", pid: process.pid, resultPids: readPidsFromFile(refsPath) });
    registerPid(refsPath, deadPid);
    ops.push({ op: "register", pid: deadPid, resultPids: readPidsFromFile(refsPath) });
    const live = getLivePids(refsPath);
    ops.push({ op: "live", resultPids: live });
    try {
      expect(live).toEqual([process.pid]);
      console.info(`[${SUITE}:live-filter] OK live=${JSON.stringify(live)}`);
    } catch (err) {
      dumpRefsSnapshot("live-filter-failure", { root, refsPath, ops, extra: { livePid: process.pid, deadPid } });
      throw err;
    }
  });
});

describe("runtime PID file", () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("writes and reads a runtime PID", () => {
    root = mkdtempSync(joinPath(tmpdir(), "rt-pid-"));
    const pidPath = joinPath(root, "runtime.pid");
    console.info(`[${SUITE}:pidfile-roundtrip] writing pid=9999 to ${pidPath}`);
    writeRuntimePid(pidPath, 9999);
    const observed = readRuntimePid(pidPath);
    try {
      expect(observed).toBe(9999);
      console.info(`[${SUITE}:pidfile-roundtrip] OK observed=${observed}`);
    } catch (err) {
      dumpRefsSnapshot("pidfile-roundtrip-failure", {
        root,
        pidPath,
        ops: [
          { op: "writePid", pidPath, pid: 9999 },
          { op: "readPid", pidPath, result: observed },
        ],
      });
      throw err;
    }
  });

  it("returns null for a missing PID file", () => {
    root = mkdtempSync(joinPath(tmpdir(), "rt-pid-"));
    const pidPath = joinPath(root, "runtime.pid");
    console.info(`[${SUITE}:pidfile-missing] reading without writing pidPath=${pidPath}`);
    const observed = readRuntimePid(pidPath);
    try {
      expect(observed).toBeNull();
      console.info(`[${SUITE}:pidfile-missing] OK observed=${observed}`);
    } catch (err) {
      dumpRefsSnapshot("pidfile-missing-failure", {
        root,
        pidPath,
        ops: [{ op: "readPid", pidPath, result: observed }],
      });
      throw err;
    }
  });
});
