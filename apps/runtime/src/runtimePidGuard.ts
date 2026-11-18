/**
 * Round-11 K3 (L1 hot-patch): port-bind pre-flight guard.
 *
 * Background — round-10 forensics: a SECOND `bun --hot src/index.ts` runtime
 * process spawned mid-job, hit the empty in-memory `producedCache`, threw
 * `STEP_COMMIT_PRODUCED_MISSING`, and overwrote `runtime_jobs.db` with
 * status=failed even though the FIRST runtime had already written the
 * library rows correctly. The user-observable symptom: "ingest job failed,
 * yet the movie became playable anyway".
 *
 * Round-11 v1 (PID-liveness probe) shipped first and worked correctly when
 * the runtime was started by hand. **L1 hot-patch** rewrites the pre-flight
 * to probe the runtime's TCP port instead, because the v1 PID approach
 * conflicted with `RuntimeGuardian`'s normal kill-respawn lifecycle:
 *
 * - Guardian SIGKILLs the runtime → kernel reaps the PID asynchronously.
 * - Guardian respawns the runtime within 2s.
 * - The new boot's `process.kill(<oldPid>, 0)` probe sometimes catches the
 *   prior PID still in the zombie window before kernel reap → returns true
 *   → guardian sees the spawn fail (exit 0) → respawns again 2s later.
 *   Loop.
 *
 * The actual exclusion we wanted in round 10 was "no two processes binding
 * port 3020" (the EADDRINUSE that triggered the round-10 dual-spawn). PID
 * files don't survive SIGKILL gracefully and are racy under guardian
 * respawn; ports have NO zombie state — once `bun` exits, the kernel
 * releases the port immediately.
 *
 * L1 contract:
 *
 * - Probe the runtime's intended port via `net.createConnection` to
 *   `127.0.0.1:<port>`. 150ms timeout (plenty for localhost).
 * - If a connection succeeds, another runtime is already serving — log
 *   error (enriched with the PID-file content for kill-recipe ergonomics)
 *   and `exit(0)`.
 * - If the port is free, write our PID to the file (still useful as a
 *   kill target via `kill -KILL "$(cat <runtime data dir>/runtime.pid)"`)
 *   and proceed. Stale file content is overwritten unconditionally.
 *
 * The PID file is now demoted to "kill-target observability" — it never
 * gates the boot decision. That avoids every PID-life-cycle edge case
 * (zombie reap, stale-on-SIGKILL, kernel PID reuse).
 *
 * The pre-flight is extracted as a standalone helper so unit tests can
 * exercise it without spawning a real `bun` subprocess. `index.ts` calls
 * `await assertNoRuntimeAlready({ pidPath, runtimePort })`.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";

export type RuntimePidGuardOptions = {
  /**
   * Absolute path to the PID file. Typically `<runtimeDataDir>/runtime.pid`.
   * In L1 the file is observability/kill-target — it never gates the boot
   * decision. The boot decision is `isPortBound(runtimePort)`.
   */
  pidPath: string;
  /**
   * Port the runtime intends to bind. Probed via TCP connect to
   * `127.0.0.1:<port>`. If the port already accepts connections, refuse
   * to boot.
   */
  runtimePort: number;
  /** Current process PID. Defaulted by the index.ts caller; injectable for tests. */
  currentPid?: number;
  /**
   * Process-exit hook. Defaults to `process.exit`. Tests inject a spy that
   * THROWS so the test can assert exit-was-attempted without actually
   * exiting the test runner.
   */
  exit?: (code: number) => never;
  /**
   * Port-bind probe. Defaults to `defaultIsPortBound` (TCP connect with
   * 150ms timeout). Tests inject a stub that resolves true/false directly
   * to keep unit tests free of real sockets.
   *
   * Convention: returns true if `127.0.0.1:<port>` accepts a connection
   * within the timeout, false otherwise.
   */
  isPortBound?: (port: number) => Promise<boolean>;
  /** Logger. Defaults to console.error/warn. Tests inject spies. */
  log?: {
    error: (message: string) => void;
    warn: (message: string) => void;
  };
};

/**
 * 150ms is plenty for a localhost probe — typical loopback connect lands
 * in <5ms. The timeout exists only to bound the boot delay if the kernel
 * is paging the network stack during a hot-restart. Tests inject a stub
 * isPortBound and never hit this path.
 */
const PORT_PROBE_TIMEOUT_MS = 150;

export const defaultIsPortBound = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const settle = (bound: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // best-effort
      }
      resolve(bound);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => settle(false));
  });

const defaultExit = (code: number): never => {
  process.exit(code);
};

const defaultLog = {
  error: (message: string) => console.error(message),
  warn: (message: string) => console.warn(message),
};

const readPidHint = (pidPath: string): string => {
  try {
    if (!existsSync(pidPath)) return "";
    const raw = readFileSync(pidPath, "utf-8").trim();
    if (raw.length === 0) return "";
    // Don't validate strictly here — the message is just a hint for the
    // operator. If the file contents are garbled, surface them anyway.
    return ` (pid in file: ${raw.slice(0, 32)})`;
  } catch {
    return "";
  }
};

/**
 * Pre-flight guard. Run BEFORE engine startup. Behaviour (L1):
 *   - Port already bound → log error, call exit(0). Returns never.
 *   - Port free → write current PID to the PID file, return.
 *
 * The PID file is overwritten unconditionally on the success path; stale
 * content is fine, the next boot's `isPortBound` check is the source of
 * truth.
 */
export const assertNoRuntimeAlready = async (
  options: RuntimePidGuardOptions
): Promise<void> => {
  const {
    pidPath,
    runtimePort,
    currentPid = process.pid,
    exit = defaultExit,
    isPortBound = defaultIsPortBound,
    log = defaultLog,
  } = options;

  if (await isPortBound(runtimePort)) {
    log.error(
      `[runtime] another runtime is already serving on port ${runtimePort}${readPidHint(pidPath)}. Exiting cleanly.`
    );
    exit(0);
    // exit() returns never; this line is unreachable in production but
    // tests inject a throwing exit so we still want a defensive return.
    return;
  }

  // Port is free → write our PID for kill-recipe + observability. Overwrites
  // any stale file content unconditionally — that's intended.
  writeFileSync(pidPath, String(currentPid));
};

/**
 * Best-effort cleanup on graceful shutdown. Does NOT fail loudly if the file
 * is already gone (a sibling process or external `rm` may have cleared it).
 * Unlinks only a file that still names `ownerPid` (#25 P4): the drain frees
 * the port before its slow steps, so a relaunched runtime may already have
 * written its own pid here.
 */
export const releaseRuntimePidFile = (pidPath: string, ownerPid: number): void => {
  try {
    if (readFileSync(pidPath, "utf8").trim() === String(ownerPid)) unlinkSync(pidPath);
  } catch {
    // best-effort
  }
};
