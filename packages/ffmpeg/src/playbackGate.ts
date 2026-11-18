import type { ProcessControlBackend, ProcessHandle } from "@space/desktop-platform";
import { getDesktopPlatform } from "@space/desktop-platform";

/**
 * What a transcode does while a video plays on this computer (#25, Chris
 * 2026-10-13). One policy for the whole runtime, the SAME lease the upload
 * gate uses (`uploadPlaybackGate`, content-core): the runtime binds the two in
 * `apps/runtime/src/core/encodePlaybackBinding.ts`. This module owns the
 * effect on ffmpeg processes; it never decides anything.
 *
 *   full     nothing changes
 *   throttle every running and newly started transcode ffmpeg is confined to
 *            ONE logical core (all of them share that one core)
 *   pause    every running transcode ffmpeg is FROZEN in place (the process is
 *            suspended, nothing restarts, no work is lost) and no new
 *            transcode starts; everything continues from the same point when
 *            the policy leaves `pause`
 *
 * Only children registered with `attach` are touched, and only transcode
 * encodes register (`playbackGated` on the ffmpeg task; probes, previews and
 * ffprobe are short and are not gated).
 *
 * This module owns NO OS code: the effect on a process (freeze, one core,
 * restore) is `getDesktopPlatform().processes.control`, a
 * `ProcessControlBackend` defined by `@space/desktop-platform-contract` and
 * implemented per OS in `@space/desktop-platform-<os>` (Linux: SIGSTOP/SIGCONT
 * + `taskset`). The
 * backend is resolved on first use; tests pass their own through `backend`.
 *
 * Nothing here can stay stuck: the policy follows the lease (it expires on its
 * own), `resumeNow` thaws a child before it is killed (a stopped process does
 * not act on SIGTERM), and `shutdown` thaws everything.
 */

export type EncodePlaybackPolicy = "full" | "throttle" | "pause";

/** What a registered child hands back to its spawner. */
export type ChildGate = {
  /** The child exited (or was never real): forget it. */
  release: () => void;
  /** About to be killed: thaw it so the signal is delivered, and never freeze it again. */
  resumeNow: () => void;
  isSuspended: () => boolean;
  /** Frozen / thawed notifications, for wall-clock timers that must not count frozen time. Returns an unsubscribe. */
  onSuspendedChange: (listener: (suspended: boolean) => void) => () => void;
};

export type EncodePlaybackGate = {
  getPolicy: () => EncodePlaybackPolicy;
  setPolicy: (policy: EncodePlaybackPolicy, context?: Record<string, unknown>) => void;
  attach: (pid: number | undefined) => ChildGate;
  /**
   * Resolves `true` once a new transcode may start (immediately unless the
   * policy is `pause`), `false` when `signal` aborted first.
   */
  whenRunnable: (signal?: AbortSignal) => Promise<boolean>;
  snapshot: () => { policy: EncodePlaybackPolicy; children: number; suspended: number; throttled: number; waiting: number; backend: string };
  /** Runtime is going down: thaw and restore everything, release waiters, ignore further changes. Permanent. */
  shutdown: () => void;
};

export type EncodePlaybackGateDeps = {
  /** Default: the host platform's `processes.control`, resolved on first use. */
  backend?: ProcessControlBackend;
  info: (message: string, data: Record<string, unknown>) => void;
  warn: (message: string, data: Record<string, unknown>) => void;
};

/** Gate handle of a child that is not (or could not be) controlled. */
export const NOT_GATED_CHILD: ChildGate = {
  release: () => {},
  resumeNow: () => {},
  isSuspended: () => false,
  onSuspendedChange: () => () => {},
};

type Child = {
  pid: number;
  handle: ProcessHandle;
  suspended: boolean;
  throttled: boolean;
  /** About to be killed: left alone from now on. */
  doomed: boolean;
  listeners: Set<(suspended: boolean) => void>;
};

type Waiter = { resolve: (runnable: boolean) => void; cleanup: () => void };

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const createEncodePlaybackGate = (overrides: Partial<EncodePlaybackGateDeps> = {}): EncodePlaybackGate => {
  const deps = {
    info: (message: string, data: Record<string, unknown>) => console.info(message, data),
    warn: (message: string, data: Record<string, unknown>) => console.warn(message, data),
    ...overrides,
  };
  let backend: ProcessControlBackend | null = overrides.backend ?? null;
  // Resolved on first use, not at import: a host OS without a platform package
  // must not break importing this module (the singleton below is built at import).
  const backendOf = (): ProcessControlBackend => (backend ??= getDesktopPlatform().processes.control);
  let policy: EncodePlaybackPolicy = "full";
  let closed = false;
  let failureLogged = false;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  const children = new Set<Child>();
  const waiters = new Set<Waiter>();

  /** Runs one OS call; a failure is logged once per process and never reaches the encode. */
  const attempt = (action: string, pid: number, fn: () => void): boolean => {
    try {
      fn();
      return true;
    } catch (err) {
      if (!failureLogged) {
        failureLogged = true;
        deps.warn("[ffmpeg] playback gate could not control an encoder process (logged once)", {
          action,
          pid,
          backend: backend?.name ?? "unresolved",
          policy,
          error: errorMessage(err),
        });
      }
      return false;
    }
  };

  const setSuspended = (child: Child, suspended: boolean) => {
    child.suspended = suspended;
    for (const listener of [...child.listeners]) listener(suspended);
  };

  const apply = (child: Child) => {
    if (child.doomed) return;
    const want: EncodePlaybackPolicy = closed ? "full" : policy;
    // Cores first, then freeze/thaw: a thawing child must already be pinned,
    // or it would run full width for an instant.
    if (want === "throttle" && !child.throttled) {
      child.throttled = attempt("throttle", child.pid, () => child.handle.throttle());
    } else if (want === "full" && child.throttled) {
      child.throttled = !attempt("unthrottle", child.pid, () => child.handle.unthrottle());
    }
    if (want === "pause" && !child.suspended) {
      if (attempt("suspend", child.pid, () => child.handle.suspend())) setSuspended(child, true);
    } else if (want !== "pause" && child.suspended) {
      if (attempt("resume", child.pid, () => child.handle.resume())) setSuspended(child, false);
    }
  };

  const syncReconcileTimer = () => {
    const reconcileMs = backend?.reconcileMs ?? 0;
    const needed = reconcileMs > 0 && !closed && [...children].some((child) => child.throttled && !child.doomed);
    if (needed && reconcileTimer === null) {
      reconcileTimer = setInterval(() => {
        for (const child of children) {
          if (child.throttled && !child.doomed) attempt("refresh", child.pid, () => child.handle.refresh?.());
        }
      }, reconcileMs);
      reconcileTimer.unref?.();
    } else if (!needed && reconcileTimer !== null) {
      clearInterval(reconcileTimer);
      reconcileTimer = null;
    }
  };

  const flushWaiters = () => {
    for (const waiter of [...waiters]) {
      waiter.cleanup();
      waiter.resolve(true);
    }
  };

  const snapshot = () => ({
    policy,
    children: children.size,
    suspended: [...children].filter((child) => child.suspended).length,
    throttled: [...children].filter((child) => child.throttled).length,
    waiting: waiters.size,
    backend: backend?.name ?? "unresolved",
  });

  return {
    getPolicy: () => policy,
    setPolicy: (next, context = {}) => {
      if (closed || next === policy) return;
      const from = policy;
      policy = next;
      for (const child of [...children]) apply(child);
      syncReconcileTimer();
      if (next !== "pause") flushWaiters();
      deps.info("[ffmpeg] playback gate policy changed", { from, to: next, ...snapshot(), ...context });
    },
    attach: (pid) => {
      if (closed || typeof pid !== "number") return NOT_GATED_CHILD;
      let handle: ProcessHandle | null = null;
      attempt("open", pid, () => {
        handle = backendOf().open(pid);
      });
      if (!handle) return NOT_GATED_CHILD;
      const child: Child = { pid, handle, suspended: false, throttled: false, doomed: false, listeners: new Set() };
      children.add(child);
      apply(child);
      syncReconcileTimer();
      return {
        release: () => {
          if (!children.delete(child)) return;
          attempt("close", pid, () => child.handle.close());
          child.listeners.clear();
          syncReconcileTimer();
        },
        resumeNow: () => {
          child.doomed = true;
          if (child.suspended && attempt("resume", pid, () => child.handle.resume())) setSuspended(child, false);
        },
        isSuspended: () => child.suspended,
        onSuspendedChange: (listener) => {
          child.listeners.add(listener);
          return () => {
            child.listeners.delete(listener);
          };
        },
      };
    },
    whenRunnable: (signal) => {
      if (closed || policy !== "pause") return Promise.resolve(true);
      if (signal?.aborted) return Promise.resolve(false);
      // Not Promise.withResolvers: the desktop typecheck compiles this file
      // against a pre-ES2024 lib.
      return new Promise<boolean>((resolve) => {
        const onAbort = () => {
          waiter.cleanup();
          resolve(false);
        };
        const waiter: Waiter = {
          resolve,
          cleanup: () => {
            waiters.delete(waiter);
            signal?.removeEventListener("abort", onAbort);
          },
        };
        waiters.add(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    snapshot,
    shutdown: () => {
      if (closed) return;
      const before = snapshot();
      closed = true;
      for (const child of [...children]) apply(child);
      syncReconcileTimer();
      flushWaiters();
      deps.info("[ffmpeg] playback gate shut down: encoders thawed", before);
    },
  };
};

/** The runtime-wide gate every gated `@space/ffmpeg` spawn registers with. */
export const encodePlaybackGate: EncodePlaybackGate = createEncodePlaybackGate();
