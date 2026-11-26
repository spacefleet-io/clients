/**
 * #25 P10 — a slow fsync must not block /runtime/health.
 *
 * Ultimate baseline b51ea3c4: the runtime main thread sat in D state
 * (`wait_for_commit`) inside `fsync runtime-data`, `fsync user-data/library`,
 * `fsync library.core.sqlite-wal` and `fsync runtime_jobs.db-wal`. Every
 * SQLite statement runs on the event loop, and WAL + synchronous=NORMAL still
 * fsyncs there (creating the file and switching it to WAL, the WAL header plus
 * the directory on the first commit of each WAL generation, every
 * autocheckpoint). On a busy disk one fsync took seconds, the health probe
 * timed out, the guardian killed the runtime and cases waited 38-79 s.
 *
 * The test builds a tiny LD_PRELOAD shim that makes every fsync/fdatasync
 * take SF_SLOW_FSYNC_MS and logs the calling thread and target. A Bun child
 * (the runtime's engine) serves a health route and, on the same event loop,
 * opens a fresh runtime jobs DB (prepared first, as EngineV2.start does) and a
 * fresh library through the production openers and writes enough to cross
 * SQLite's 1000-page autocheckpoint. The
 * test polls health throughout and expects:
 *  - no fsync on the main thread between the workload markers;
 *  - every health answer in under 1 s.
 *
 * Needs Linux, `bun` and a C compiler (`cc`) for the shim; it is skipped
 * (logged) otherwise. The CI image has no compiler: there,
 * packages/library-db-runtime/tests/wal-checkpointer.test.ts covers the
 * mechanism.
 *
 * Real waits on purpose: the test measures wall-clock latency of a real
 * child process under real (shimmed) fsyncs; fake timers cannot drive that.
 *
 * @bugfix @regression-proof
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

const SUITE = "sqlite-fsync-off-event-loop";
const REPO = resolve(__dirname, "../../..");
const SLOW_FSYNC_MS = 1_500;
const HEALTH_BUDGET_MS = 1_000;

const log = (phase: string, data: Record<string, unknown> = {}) =>
  console.info(`[${SUITE}:${phase}] ${JSON.stringify(data)}`);

const SHIM_SOURCE = String.raw`
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/syscall.h>
static void slow(const char *name, int fd) {
  char link[64], target[512];
  snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
  ssize_t n = readlink(link, target, sizeof target - 1);
  target[n > 0 ? n : 0] = 0;
  long tid = syscall(SYS_gettid);
  fprintf(stderr, "[slow-fsync] %s main=%d tid=%ld target=%s\n", name, tid == getpid(), tid, target);
  const char *ms = getenv("SF_SLOW_FSYNC_MS");
  if (ms) usleep(atoi(ms) * 1000);
}
int fsync(int fd) { static int (*real)(int); if (!real) real = dlsym(RTLD_NEXT, "fsync"); slow("fsync", fd); return real(fd); }
int fdatasync(int fd) { static int (*real)(int); if (!real) real = dlsym(RTLD_NEXT, "fdatasync"); slow("fdatasync", fd); return real(fd); }
`;

const fixtureSource = (dataDir: string) => `
import { createSqliteRuntimeJobsStore, prepareSqliteRuntimeJobsStore } from ${JSON.stringify(join(REPO, "packages/runtime-jobs-engine/src/sqliteStore.ts"))};
import { LibraryDb } from ${JSON.stringify(join(REPO, "packages/library-db-runtime/src/libraryDb.ts"))};

const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
console.log("PORT " + server.port);
// Let the test start polling before the workload.
await Bun.sleep(500);

console.error("WORKLOAD start");
const jobsDbPath = ${JSON.stringify(join(dataDir, "runtime_jobs.db"))};
await prepareSqliteRuntimeJobsStore(jobsDbPath);
const store = createSqliteRuntimeJobsStore(jobsDbPath);
const blob = "x".repeat(8_000);
for (let i = 0; i < 600; i += 1) {
  const now = new Date().toISOString();
  store.upsertJob({
    jobId: "job-" + i, app: "badger", kind: "source", lane: "source", status: "queued",
    stageCode: "queued", stageLabel: "Queued",
    progress: { mode: "fraction", completed: 0, total: 100, unit: "percent" }, progressPct: 0,
    payload: { userId: "u1", blob }, outputs: {}, errorCode: null, errorMessage: null,
    retryable: false, cancelRequested: false, priority: 0, dedupeKey: null,
    createdAt: now, updatedAt: now, startedAt: null, finishedAt: null,
    groupId: "g1", mediaId: "m" + i, variant: null, parentJobIds: [], dismissedAt: null,
    uploadSpeedBytesPerSec: null,
  });
  // Yield like the engine does between commits, so health can be served.
  if (i % 20 === 19) await Bun.sleep(0);
}
const library = await LibraryDb.openLocal("token-test", Buffer.alloc(32, 7).toString("base64"));
console.error("WORKLOAD end");
await Bun.sleep(${SLOW_FSYNC_MS} * 2);
library.close();
store.close();
console.error("CLOSED");
server.stop(true);
process.exit(0);
`;

const toolOk = (cmd: string) => spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
const canRun = process.platform === "linux" && toolOk("bun") && toolOk("cc");
if (!canRun) log("skip", { platform: process.platform, bun: toolOk("bun"), cc: toolOk("cc") });

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length > 0) {
    try {
      cleanup.pop()?.();
    } catch {
      // best effort
    }
  }
});

describe.skipIf(!canRun)("@bugfix @regression-proof slow fsync does not block health (#25 P10)", () => {
  it("runtime jobs DB + library writes never fsync on the event loop; health answers < 1 s", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-slow-fsync-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const shimSrc = join(dir, "slowfsync.c");
    const shim = join(dir, "slowfsync.so");
    writeFileSync(shimSrc, SHIM_SOURCE);
    const cc = spawnSync("cc", ["-shared", "-fPIC", "-O2", "-o", shim, shimSrc, "-ldl"], { encoding: "utf8" });
    log("shim-built", { status: cc.status, stderr: cc.stderr });
    expect(cc.status).toBe(0);

    const dataDir = join(dir, "runtime-data");
    const userData = join(dir, "user-data");
    spawnSync("mkdir", ["-p", dataDir, userData]);
    const fixture = join(dir, "fixture.ts");
    writeFileSync(fixture, fixtureSource(dataDir));

    const child: ChildProcess = spawn("bun", [fixture], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        LD_PRELOAD: shim,
        SF_SLOW_FSYNC_MS: String(SLOW_FSYNC_MS),
        SF_USER_DATA_PATH: userData,
      },
    });
    cleanup.push(() => child.kill("SIGKILL"));
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
    const { promise: exited, resolve: onExit } = Promise.withResolvers<number | null>();
    child.on("close", onExit);

    let port: number | null = null;
    const startDeadline = Date.now() + 30_000;
    while (port === null && Date.now() < startDeadline) {
      const m = /PORT (\d+)/.exec(stdout);
      if (m) port = Number(m[1]);
      else await sleep(20);
    }
    log("child-started", { port, stderr: stderr.slice(-500) });
    expect(port).not.toBeNull();

    const latencies: Array<{ at: number; ms: number; ok: boolean }> = [];
    const pollDeadline = Date.now() + 120_000;
    while (!stderr.includes("WORKLOAD end") && Date.now() < pollDeadline) {
      const startedAt = Date.now();
      const ok = await fetch(`http://127.0.0.1:${port}/runtime/health`).then(
        (res) => res.ok,
        () => false
      );
      latencies.push({ at: startedAt, ms: Date.now() - startedAt, ok });
      await sleep(50);
    }
    const exitCode = await exited;

    const workload = stderr.slice(stderr.indexOf("WORKLOAD start"), stderr.indexOf("WORKLOAD end"));
    const fsyncs = stderr.split("\n").filter((l) => l.startsWith("[slow-fsync]"));
    const mainInWorkload = workload.split("\n").filter((l) => l.startsWith("[slow-fsync]") && l.includes("main=1"));
    const worst = latencies.reduce((max, l) => Math.max(max, l.ms), 0);
    log("result", {
      exitCode,
      polls: latencies.length,
      worstHealthMs: worst,
      slowPolls: latencies.filter((l) => l.ms >= HEALTH_BUDGET_MS),
      fsyncsTotal: fsyncs.length,
      mainThreadFsyncsInWorkload: mainInWorkload.map((l) => l.replace(dir, "<tmp>")),
      offLoopFsyncs: fsyncs.filter((l) => l.includes("main=0")).length,
      stderrTail: stderr.slice(-2000).replaceAll(dir, "<tmp>"),
    });
    expect(stderr).toContain("WORKLOAD end");
    expect(stderr).toContain("CLOSED");
    // The shim intercepted (the worker did slow syncs) and health was really polled.
    expect(fsyncs.filter((l) => l.includes("main=0")).length).toBeGreaterThan(0);
    expect(latencies.length).toBeGreaterThan(0);
    expect(latencies.filter((l) => !l.ok)).toEqual([]);
    expect(mainInWorkload).toEqual([]);
    expect(worst).toBeLessThan(HEALTH_BUDGET_MS);
  }, 180_000);
});
