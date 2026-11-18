/**
 * @bugfix all-newly-added-jobs-cuddly-cookie
 * @regression-proof
 *
 * Bug B from the plan file. The desktop renderer had no way to know the
 * runtime had been restarted (process crash, `bun --hot` reload, manual
 * Settings → Restart). The renderer's auth-attach and key-forward effects
 * were keyed on `[token, user?.id]` and `[libraryKey]` — neither changes
 * when the runtime restarts mid-session, so the effects did not refire and
 * the runtime's in-memory `IngestUserState` / `backendToken` stayed empty.
 * New ingest jobs then failed at the Extract step with
 * `BADGER_AUTH_NOT_READY` and replan jobs at retranscode with
 * `STEP_RETRANSCODE_AUTH_NOT_READY`.
 *
 * Fix: a new `useRuntimeInstanceId()` hook in
 * `packages/desktop-shell/src/services/runtime-status.ts` returns a
 * monotonic counter that increments every time the runtime transitions to
 * `"ready"` (first spawn AND every respawn). Threading this into the
 * dependency array of the auth.tsx + libraryContext.tsx effects forces a
 * fresh attach + forward after every restart.
 *
 * This file pins the hook's contract: counter starts at 0, bumps once on
 * the initial "ready" snapshot, bumps again on every transition INTO
 * "ready", and does NOT bump on same-status pings or non-ready
 * transitions. Effects threading the counter rely on these guarantees.
 *
 * Pre-fix: hook does not exist; useEffect deps cannot react to runtime
 *   restart; attach-auth never re-runs.
 * Post-fix: counter bumps drive useEffect refire on each runtime ready.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import React from "react";
import { useRuntimeInstanceId } from "../src/services/runtime-status";

type StatusHandler = (payload: { status: string }) => void;

const HookProbe = ({
  onChange,
}: {
  onChange: (id: number) => void;
}) => {
  const id = useRuntimeInstanceId();
  React.useEffect(() => {
    onChange(id);
  }, [id, onChange]);
  return <div data-testid="instance-id">{id}</div>;
};

let registeredHandlers: StatusHandler[] = [];
let getStatusImpl: (() => Promise<{ status: string }>) | null = null;

const installBridge = () => {
  registeredHandlers = [];
  (globalThis as unknown as { window: { sf?: unknown } }).window = {
    ...(globalThis as unknown as { window?: { sf?: unknown } }).window,
    sf: {
      runtime: {
        getStatus: () =>
          getStatusImpl
            ? getStatusImpl()
            : Promise.resolve({ status: "unknown" }),
        onStatusChange: (handler: StatusHandler) => {
          registeredHandlers.push(handler);
          console.info(
            `[use-runtime-instance-id] subscriber registered; total=${registeredHandlers.length}`,
          );
          return () => {
            registeredHandlers = registeredHandlers.filter((h) => h !== handler);
          };
        },
      },
    },
  };
};

const fireStatus = (status: string) => {
  console.info(
    `[use-runtime-instance-id] firing status=${status} to ${registeredHandlers.length} subscriber(s)`,
  );
  for (const handler of registeredHandlers) {
    handler({ status });
  }
};

// On assertion failure, dump the full onChange call history + subscriber state
// so a counter-mismatch is diagnosable offline (tests self-diagnose). Wrapped
// in try/catch so a dump failure can't mask the real assertion failure.
const dumpInstanceIdSnapshot = (
  label: string,
  ctx: { onChange?: ReturnType<typeof vi.fn>; expected?: number },
) => {
  try {
    console.error(`=== [use-runtime-instance-id:${label}] snapshot ===`);
    if (ctx.onChange) {
      const calls = ctx.onChange.mock.calls as unknown[][];
      const lastCall = calls.length > 0 ? calls[calls.length - 1] : null;
      console.error(
        `onChange calls=${calls.length} lastValue=${JSON.stringify(lastCall)} expected=${JSON.stringify(ctx.expected)}`,
      );
      console.error(`onChange full call history:\n${JSON.stringify(calls, null, 2)}`);
    }
    console.error(`registeredHandlers=${registeredHandlers.length}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

beforeEach(() => {
  installBridge();
  getStatusImpl = null;
});

afterEach(() => {
  registeredHandlers = [];
  vi.restoreAllMocks();
});

describe("@bugfix @regression-proof useRuntimeInstanceId — bumps on each ready transition", () => {
  it("counter starts at 0 before the initial status snapshot resolves", () => {
    console.info("[use-runtime-instance-id:starts-at-zero] getStatus hangs; observing pre-resolve state");
    // Make getStatus hang so we observe the pre-resolve state.
    getStatusImpl = () => new Promise(() => undefined);
    const onChange = vi.fn<(id: number) => void>();
    render(<HookProbe onChange={onChange} />);
    try {
      expect(onChange).toHaveBeenLastCalledWith(0);
    } catch (err) {
      dumpInstanceIdSnapshot("starts-at-zero", { onChange, expected: 0 });
      throw err;
    }
  });

  it("bumps to 1 once the initial snapshot reports ready", async () => {
    console.info("[use-runtime-instance-id:initial-ready] getStatus resolves status=ready");
    getStatusImpl = () => Promise.resolve({ status: "ready" });
    const onChange = vi.fn<(id: number) => void>();
    render(<HookProbe onChange={onChange} />);
    // Flush the getStatus().then() microtask.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    console.info(
      "[use-runtime-instance-id:initial-ready] post-initial-ready calls:",
      JSON.stringify(onChange.mock.calls),
    );
    try {
      expect(onChange).toHaveBeenLastCalledWith(1);
    } catch (err) {
      dumpInstanceIdSnapshot("initial-ready", { onChange, expected: 1 });
      throw err;
    }
  });

  it("does NOT bump on the initial snapshot when runtime is not ready", async () => {
    console.info("[use-runtime-instance-id:initial-not-ready] getStatus resolves status=restarting");
    getStatusImpl = () => Promise.resolve({ status: "restarting" });
    const onChange = vi.fn<(id: number) => void>();
    render(<HookProbe onChange={onChange} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    try {
      expect(onChange).toHaveBeenLastCalledWith(0);
    } catch (err) {
      dumpInstanceIdSnapshot("initial-not-ready", { onChange, expected: 0 });
      throw err;
    }
  });

  it("bumps on the first ready event after a restarting transition (the production case)", async () => {
    console.info("[use-runtime-instance-id:restart-cycle] simulating ready → restarting → ready");
    // Simulates the live restart sequence we read from runtime.log:
    //   ready (initial) → restarting → ready → ...
    // Effects depending on the counter must refire after the second ready.
    getStatusImpl = () => Promise.resolve({ status: "ready" });
    const onChange = vi.fn<(id: number) => void>();
    render(<HookProbe onChange={onChange} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    try {
      expect(onChange).toHaveBeenLastCalledWith(1);
    } catch (err) {
      dumpInstanceIdSnapshot("restart-cycle-after-initial-ready", { onChange, expected: 1 });
      throw err;
    }

    console.info("[use-runtime-instance-id:restart-cycle] firing restarting (must NOT bump)");
    act(() => fireStatus("restarting"));
    try {
      expect(onChange).toHaveBeenLastCalledWith(1); // restarting must NOT bump
    } catch (err) {
      dumpInstanceIdSnapshot("restart-cycle-after-restarting", { onChange, expected: 1 });
      throw err;
    }

    console.info("[use-runtime-instance-id:restart-cycle] firing ready (must bump to 2)");
    act(() => fireStatus("ready"));
    try {
      expect(onChange).toHaveBeenLastCalledWith(2);
    } catch (err) {
      dumpInstanceIdSnapshot("restart-cycle-after-second-ready", { onChange, expected: 2 });
      throw err;
    }
  });

  it("does NOT bump on repeated same-status ready pings", async () => {
    console.info("[use-runtime-instance-id:repeated-ready] verifying repeated ready pings don't bump");
    // Defensive: the runtime broadcaster currently fires once on each
    // transition, but a future refactor that sends periodic heartbeats
    // must not retrigger attach-auth on every beacon.
    getStatusImpl = () => Promise.resolve({ status: "ready" });
    const onChange = vi.fn<(id: number) => void>();
    render(<HookProbe onChange={onChange} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    try {
      expect(onChange).toHaveBeenLastCalledWith(1);
    } catch (err) {
      dumpInstanceIdSnapshot("repeated-ready-after-initial", { onChange, expected: 1 });
      throw err;
    }

    console.info("[use-runtime-instance-id:repeated-ready] firing ready ping #2 (must stay 1)");
    act(() => fireStatus("ready"));
    try {
      expect(onChange).toHaveBeenLastCalledWith(1);
    } catch (err) {
      dumpInstanceIdSnapshot("repeated-ready-after-ping2", { onChange, expected: 1 });
      throw err;
    }
    console.info("[use-runtime-instance-id:repeated-ready] firing ready ping #3 (must stay 1)");
    act(() => fireStatus("ready"));
    try {
      expect(onChange).toHaveBeenLastCalledWith(1);
    } catch (err) {
      dumpInstanceIdSnapshot("repeated-ready-after-ping3", { onChange, expected: 1 });
      throw err;
    }
  });

  it("bumps multiple times across successive restart cycles", async () => {
    console.info("[use-runtime-instance-id:multi-cycle] 3 successive restart cycles, expect 2..4");
    getStatusImpl = () => Promise.resolve({ status: "ready" });
    const onChange = vi.fn<(id: number) => void>();
    render(<HookProbe onChange={onChange} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    try {
      expect(onChange).toHaveBeenLastCalledWith(1);
    } catch (err) {
      dumpInstanceIdSnapshot("multi-cycle-after-initial", { onChange, expected: 1 });
      throw err;
    }

    for (let cycle = 2; cycle <= 4; cycle += 1) {
      console.info(
        `[use-runtime-instance-id:multi-cycle] cycle=${cycle} firing restarting then ready`,
      );
      act(() => fireStatus("restarting"));
      act(() => fireStatus("ready"));
      try {
        expect(onChange).toHaveBeenLastCalledWith(cycle);
      } catch (err) {
        dumpInstanceIdSnapshot(`multi-cycle-cycle-${cycle}`, { onChange, expected: cycle });
        throw err;
      }
    }
  });
});
