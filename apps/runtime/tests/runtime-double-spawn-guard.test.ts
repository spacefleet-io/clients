/**
 * @bugfix @regression-proof
 *
 * effervescent-teapot Round 11 K3 (L1 hot-patch): port-bind pre-flight
 * guard prevents a second runtime from booting when the runtime port is
 * already serving.
 *
 * Background — round-10 forensics:
 * - User-facing failure: "ingest job failed, yet the movie became playable
 *   anyway".
 * - Runtime log: `[runtime] started { pid: 3373312 }` appeared mid-job
 *   shortly before EADDRINUSE on port 3020. Two `bun --hot src/index.ts`
 *   processes were running simultaneously. The second process ticked the
 *   engine ONCE before crashing — that single tick threw
 *   STEP_COMMIT_PRODUCED_MISSING and overwrote runtime_jobs.db with
 *   status=failed before the EADDRINUSE killed it.
 *
 * Round 11 K3 v1 (PID-liveness probe) shipped first and worked correctly
 * when the runtime was started by hand. **L1 hot-patch** rewrites the
 * pre-flight to probe the runtime's TCP port instead, because the v1 PID
 * approach conflicted with `RuntimeGuardian`'s normal kill-respawn
 * lifecycle — zombie PIDs caught in the kernel-reap window triggered
 * false "alive" detection, putting desktop into a 2s respawn loop.
 *
 * L1 contract (this test guards):
 * - Probe `127.0.0.1:<runtimePort>` via `net.createConnection` with a
 *   150ms timeout.
 * - If the connection succeeds → log error, exit(0). Do NOT overwrite
 *   the PID file.
 * - If the port is free → write our PID to the file (kill-target
 *   observability) and proceed.
 * - The PID file is no longer the boot-decision source — port-bind is.
 *
 * The pre-flight is extracted as `assertNoRuntimeAlready({ ... })` in
 * `apps/runtime/src/runtimePidGuard.ts` so this test can exercise it
 * without spawning a real `bun` subprocess. We inject `exit`, `isPortBound`,
 * and `log` so the test can drive each branch deterministically.
 *
 * Branches covered:
 *   (a) Port bound → exit(0) without writing PID file.
 *   (b) Port free + missing PID file → write new PID.
 *   (c) Port free + stale PID file → overwrite with new PID, no warn.
 *   (d) Port-bound message includes the stale PID hint when the file exists.
 *   (e) Default port-probe does NOT hang for >250ms when nothing is listening
 *       (regression for the 150ms timeout decision).
 *   (f) Graceful shutdown → releaseRuntimePidFile unlinks the file.
 *   (g) releaseRuntimePidFile is no-op if the file is already missing.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertNoRuntimeAlready,
  defaultIsPortBound,
  releaseRuntimePidFile,
} from "../src/runtimePidGuard";

let scratchDir = "";
let pidPath = "";

// ---------------------------------------------------------------------------
// Diagnostic snapshot — wraps try/catch so a dump failure cannot mask the
// original assertion failure. Dumps pid-file contents + mock state.
// ---------------------------------------------------------------------------
const dumpSpawnGuardSnapshot = (
  label: string,
  ctx: {
    pidPath?: string;
    exit?: ReturnType<typeof vi.fn>;
    isPortBound?: ReturnType<typeof vi.fn>;
    log?: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
    extra?: Record<string, unknown>;
  },
) => {
  try {
    console.error(`=== [runtime-double-spawn-guard:${label}] snapshot ===`);
    if (ctx.pidPath) {
      const exists = existsSync(ctx.pidPath);
      const contents = exists ? readFileSync(ctx.pidPath, "utf8") : "(missing)";
      console.error(
        `pidPath=${ctx.pidPath} exists=${exists} contents=${JSON.stringify(contents)}`,
      );
    }
    if (ctx.exit) {
      console.error(
        `exit.callCount=${ctx.exit.mock.calls.length} calls=${JSON.stringify(ctx.exit.mock.calls)}`,
      );
    }
    if (ctx.isPortBound) {
      console.error(
        `isPortBound.callCount=${ctx.isPortBound.mock.calls.length} calls=${JSON.stringify(ctx.isPortBound.mock.calls)}`,
      );
    }
    if (ctx.log) {
      console.error(
        `log.error.calls=${JSON.stringify(ctx.log.error.mock.calls)}`,
      );
      console.error(
        `log.warn.calls=${JSON.stringify(ctx.log.warn.mock.calls)}`,
      );
    }
    if (ctx.extra) {
      console.error(`extra=\n${JSON.stringify(ctx.extra, null, 2)}`);
    }
  } catch (err) {
    console.error(
      `(snapshot failed: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
};

beforeEach(() => {
  scratchDir = mkdtempSync(joinPath(tmpdir(), "round11-l1-port-guard-"));
  mkdirSync(scratchDir, { recursive: true });
  pidPath = joinPath(scratchDir, "runtime.pid");
  console.info(
    `[runtime-double-spawn-guard:setup] scratchDir=${scratchDir} pidPath=${pidPath}`,
  );
});

afterEach(() => {
  console.info(`[runtime-double-spawn-guard:teardown] removing scratchDir=${scratchDir}`);
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

describe("@bugfix @regression-proof Round-11 K3 L1 — port-bind pre-flight guard", () => {
  it("port free + missing PID file → writes current PID and proceeds (no exit)", async () => {
    console.info(`[runtime-double-spawn-guard:port-free-no-pid] dispatching assertNoRuntimeAlready`);
    const exit = vi.fn(((_code: number) => {
      throw new Error("exit should not be called");
    }) as (code: number) => never);
    const isPortBound = vi.fn(async () => false);
    const log = { error: vi.fn(), warn: vi.fn() };

    try {
      await assertNoRuntimeAlready({
        pidPath,
        runtimePort: 13020,
        currentPid: 99999,
        exit,
        isPortBound,
        log,
      });

      expect(exit).not.toHaveBeenCalled();
      expect(isPortBound).toHaveBeenCalledWith(13020);
      expect(existsSync(pidPath)).toBe(true);
      expect(readFileSync(pidPath, "utf8")).toBe("99999");
      expect(log.error).not.toHaveBeenCalled();
      expect(log.warn).not.toHaveBeenCalled();
    } catch (err) {
      dumpSpawnGuardSnapshot("port-free-no-pid", { pidPath, exit, isPortBound, log });
      throw err;
    }
  });

  it("port bound → guard calls exit(0) and does NOT overwrite the PID file", async () => {
    writeFileSync(pidPath, "12345");
    console.info(
      `[runtime-double-spawn-guard:port-bound-no-overwrite] preloaded pid=12345; expecting exit(0)`,
    );
    const exit = vi.fn(((_code: number) => {
      throw new Error("__exit_called__");
    }) as (code: number) => never);
    const isPortBound = vi.fn(async () => true);
    const log = { error: vi.fn(), warn: vi.fn() };

    try {
      await expect(
        assertNoRuntimeAlready({
          pidPath,
          runtimePort: 13020,
          currentPid: 99999,
          exit,
          isPortBound,
          log,
        })
      ).rejects.toThrow(/__exit_called__/);

      expect(exit).toHaveBeenCalledWith(0);
      expect(isPortBound).toHaveBeenCalledWith(13020);
      // PID file must NOT be overwritten — the live runtime's PID stays put.
      expect(readFileSync(pidPath, "utf8")).toBe("12345");
    } catch (err) {
      dumpSpawnGuardSnapshot("port-bound-no-overwrite", { pidPath, exit, isPortBound, log });
      throw err;
    }
  });

  it("port-bound error message includes the stale PID hint when the file exists", async () => {
    writeFileSync(pidPath, "12345");
    console.info(`[runtime-double-spawn-guard:port-bound-pid-hint] preloaded pid=12345`);
    const exit = vi.fn(((_code: number) => {
      throw new Error("__exit_called__");
    }) as (code: number) => never);
    const log = { error: vi.fn(), warn: vi.fn() };

    try {
      await expect(
        assertNoRuntimeAlready({
          pidPath,
          runtimePort: 13020,
          currentPid: 99999,
          exit,
          isPortBound: async () => true,
          log,
        })
      ).rejects.toThrow();

      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("another runtime is already serving on port 13020")
      );
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("pid in file: 12345")
      );
    } catch (err) {
      dumpSpawnGuardSnapshot("port-bound-pid-hint", { pidPath, exit, log });
      throw err;
    }
  });

  it("port-bound error message gracefully omits PID hint when the file is missing", async () => {
    // No PID file pre-written. Helper should still log the port-bound
    // message but without a hint clause.
    console.info(`[runtime-double-spawn-guard:port-bound-no-pid-hint] no PID file pre-written`);
    const exit = vi.fn(((_code: number) => {
      throw new Error("__exit_called__");
    }) as (code: number) => never);
    const log = { error: vi.fn(), warn: vi.fn() };

    try {
      await expect(
        assertNoRuntimeAlready({
          pidPath,
          runtimePort: 13020,
          currentPid: 99999,
          exit,
          isPortBound: async () => true,
          log,
        })
      ).rejects.toThrow();

      expect(log.error).toHaveBeenCalledWith(
        expect.stringMatching(/another runtime is already serving on port 13020\. Exiting cleanly\./)
      );
    } catch (err) {
      dumpSpawnGuardSnapshot("port-bound-no-pid-hint", { pidPath, exit, log });
      throw err;
    }
  });

  it("port free + stale PID file → overwrites unconditionally (no PID-liveness probe)", async () => {
    // The L1 contract: PID file content is no longer interpreted. Port-bind
    // is the source of truth. A stale PID (any content, alive or dead in
    // PID space) doesn't affect the boot decision — we just overwrite.
    writeFileSync(pidPath, "12345");
    console.info(`[runtime-double-spawn-guard:port-free-stale-pid] preloaded pid=12345`);
    const exit = vi.fn(((_code: number) => {
      throw new Error("exit should not be called");
    }) as (code: number) => never);
    const log = { error: vi.fn(), warn: vi.fn() };

    try {
      await assertNoRuntimeAlready({
        pidPath,
        runtimePort: 13020,
        currentPid: 99999,
        exit,
        isPortBound: async () => false,
        log,
      });

      expect(exit).not.toHaveBeenCalled();
      expect(readFileSync(pidPath, "utf8")).toBe("99999");
      // No warn log on stale-file overwrite — the PID file is observability,
      // not boot-gate. Quiet path is intentional.
      expect(log.warn).not.toHaveBeenCalled();
      expect(log.error).not.toHaveBeenCalled();
    } catch (err) {
      dumpSpawnGuardSnapshot("port-free-stale-pid", { pidPath, exit, log });
      throw err;
    }
  });

  it("port free + non-numeric PID file content → still overwrites, no warning", async () => {
    // L1 demoted PID-file content from "boot-gate" to "kill-recipe hint".
    // Non-numeric content is fine — we still overwrite on the success path.
    writeFileSync(pidPath, "garbage-content");
    console.info(
      `[runtime-double-spawn-guard:port-free-garbage-pid] preloaded pid=garbage-content`,
    );
    const exit = vi.fn(((_code: number) => {
      throw new Error("exit should not be called");
    }) as (code: number) => never);
    const log = { error: vi.fn(), warn: vi.fn() };

    try {
      await assertNoRuntimeAlready({
        pidPath,
        runtimePort: 13020,
        currentPid: 99999,
        exit,
        isPortBound: async () => false,
        log,
      });

      expect(exit).not.toHaveBeenCalled();
      expect(readFileSync(pidPath, "utf8")).toBe("99999");
      expect(log.warn).not.toHaveBeenCalled();
    } catch (err) {
      dumpSpawnGuardSnapshot("port-free-garbage-pid", { pidPath, exit, log });
      throw err;
    }
  });
});

describe("@bugfix @regression-proof Round-11 K3 L1 — defaultIsPortBound timeout safety", () => {
  it("returns false within 250ms for a port nothing is listening on", async () => {
    // Pick a port well above the dev-stack range (api 3000, metadata 3002,
    // storage 3003, runtime 3020, web 5174) AND outside
    // common system service ranges. 49xxx is in the IANA dynamic/private
    // range, statistically unlikely to collide.
    const unlikelyPort = 49891;
    console.info(
      `[runtime-double-spawn-guard:default-port-timeout] probing port=${unlikelyPort}`,
    );
    const start = Date.now();
    const result = await defaultIsPortBound(unlikelyPort);
    const elapsed = Date.now() - start;
    console.info(
      `[runtime-double-spawn-guard:default-port-timeout] result=${result} elapsed=${elapsed}ms`,
    );

    try {
      expect(result).toBe(false);
      // The probe's hard timeout is 150ms. We give 100ms headroom for the
      // event-loop scheduling overhead so flaky CI doesn't bite us. The
      // important regression is "doesn't hang" — anything <250ms proves the
      // timeout is wired and connection-refused / no-listener cases short-
      // circuit cleanly.
      expect(elapsed).toBeLessThan(250);
    } catch (err) {
      dumpSpawnGuardSnapshot("default-port-timeout", {
        extra: { port: unlikelyPort, result, elapsed },
      });
      throw err;
    }
  });
});

describe("@bugfix @regression-proof Round-11 K3 — releaseRuntimePidFile", () => {
  it("unlinks the PID file when present", () => {
    writeFileSync(pidPath, "12345");
    console.info(`[runtime-double-spawn-guard:release-pid-unlink] preloaded pid=12345`);
    try {
      expect(existsSync(pidPath)).toBe(true);

      releaseRuntimePidFile(pidPath, 12345);

      expect(existsSync(pidPath)).toBe(false);
    } catch (err) {
      dumpSpawnGuardSnapshot("release-pid-unlink", { pidPath });
      throw err;
    }
  });

  it("is a best-effort no-op when the PID file is missing", () => {
    console.info(`[runtime-double-spawn-guard:release-pid-missing-noop] no pid file pre-written`);
    try {
      expect(existsSync(pidPath)).toBe(false);
      expect(() => releaseRuntimePidFile(pidPath, 12345)).not.toThrow();
      expect(existsSync(pidPath)).toBe(false);
    } catch (err) {
      dumpSpawnGuardSnapshot("release-pid-missing-noop", { pidPath });
      throw err;
    }
  });

  // #25 P4: the drain now closes the listener before its (possibly slow)
  // database closes, so a relaunched runtime can boot and write its own pid
  // while the old one is still draining. The old one must not then delete it:
  // the guardian names the port holder through this file.
  it("@bugfix @regression-proof leaves a PID file that names another runtime (#25 P4)", () => {
    writeFileSync(pidPath, "67890");
    console.info(`[runtime-double-spawn-guard:release-pid-foreign] file names 67890, releasing as 12345`);
    try {
      releaseRuntimePidFile(pidPath, 12345);
      expect(readFileSync(pidPath, "utf8")).toBe("67890");
    } catch (err) {
      dumpSpawnGuardSnapshot("release-pid-foreign", { pidPath });
      throw err;
    }
  });
});
