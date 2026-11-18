/**
 * @regression-proof lifecycle traces — @space/mpv-protocol
 *
 * The pure lifecycle reducer's canonical spec. Phase 1 of the playback-engine
 * hardening removed the dead effect machinery and three never-dispatched
 * intermediate states/events (tracks-stable/metadata-applied/vo-configured) —
 * see `src/lifecycle.ts`. These traces now cover only what the main process
 * actually produces: launch → socket-ready, teardown, and relaunch.
 *
 * `playing` is retained in the union (forward-compat + the engine's
 * isExternalReady) but is NOT reached by any current producer, so a launch
 * rests at `socket-ready`. The forward-compat `playing`/`stopping` behavior is
 * still pinned below so it can't silently drift.
 *
 * Discipline: do NOT edit traces to match a buggy reducer. If a trace appears
 * wrong, escalate.
 */

import { describe, expect, it } from "vitest";

import { reduce, type LifecycleEvent, type LifecycleState } from "../src/lifecycle";

// ---------------------------------------------------------------------------
// Trace runner (state-only — the reducer no longer emits effects)
// ---------------------------------------------------------------------------

type Trace = {
  name: string;
  events: LifecycleEvent[];
  expectedFinalState: LifecycleState;
};

// Per-suite dump helper: console.error's the full reduction path + final vs
// expected state so a trace failure is diagnosable from CI logs alone. Body
// wrapped in try/catch so a dump failure can't mask the real assertion.
const dumpLifecycleTrace = (
  trace: Trace,
  steps: string[],
  finalState: LifecycleState,
): void => {
  try {
    console.error(`=== [lifecycle-traces:${trace.name}] trace snapshot ===`);
    console.error(`events (${trace.events.length}): ${JSON.stringify(trace.events)}`);
    console.error(`reduction path: ${steps.join(" | ")}`);
    console.error(`final state:    ${JSON.stringify(finalState)}`);
    console.error(`expected state: ${JSON.stringify(trace.expectedFinalState)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const runTrace = (trace: Trace): void => {
  console.info(
    `[lifecycle-traces:run] trace="${trace.name}" events=${trace.events.length} expected=${trace.expectedFinalState.kind}`,
  );
  let state: LifecycleState = { kind: "idle" };
  const steps: string[] = ["idle"];
  for (const event of trace.events) {
    state = reduce(state, event);
    steps.push(`${event.type} → ${state.kind}`);
  }
  console.info(`[lifecycle-traces:run] trace="${trace.name}" path: ${steps.join(" | ")}`);
  try {
    // Generous on-failure diagnostic (project convention): the full path.
    expect(
      state,
      `[${trace.name}] final state. path: ${steps.join(" | ")}`,
    ).toEqual(trace.expectedFinalState);
  } catch (err) {
    dumpLifecycleTrace(trace, steps, state);
    throw err;
  }
};

// Dump helper for the forward-compat direct-reduce assertions that bypass
// runTrace (single reduce(state, event) → expected pairs).
const dumpReduceStep = (
  label: string,
  input: LifecycleState,
  event: LifecycleEvent,
  actual: LifecycleState,
  expected: LifecycleState,
): void => {
  try {
    console.error(`=== [lifecycle-traces:${label}] direct-reduce snapshot ===`);
    console.error(`input:    ${JSON.stringify(input)}`);
    console.error(`event:    ${JSON.stringify(event)}`);
    console.error(`actual:   ${JSON.stringify(actual)}`);
    console.error(`expected: ${JSON.stringify(expected)}`);
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

const expectReduce = (
  label: string,
  input: LifecycleState,
  event: LifecycleEvent,
  expected: LifecycleState,
): void => {
  const actual = reduce(input, event);
  try {
    expect(actual).toEqual(expected);
  } catch (err) {
    dumpReduceStep(label, input, event, actual, expected);
    throw err;
  }
};

const launch = (launchId = 1, startedAt = 1000): LifecycleEvent => ({
  type: "launch_started",
  launchId,
  startedAt,
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

describe("@regression-proof lifecycle traces (state-only)", () => {
  it("cold-start: idle → launching → socket-ready (rests here; no producer advances to playing)", () => {
    runTrace({
      name: "cold-start to socket-ready",
      events: [launch(1, 1000), { type: "socket_ready" }],
      expectedFinalState: { kind: "socket-ready", launchId: 1 },
    });
  });

  it("launch_started from idle → launching, carrying launchId + startedAt", () => {
    runTrace({
      name: "launch from idle",
      events: [launch(7, 4242)],
      expectedFinalState: { kind: "launching", launchId: 7, startedAt: 4242 },
    });
  });

  it("socket_failed during launching → idle", () => {
    runTrace({
      name: "socket_failed while launching",
      events: [launch(1, 1000), { type: "socket_failed" }],
      expectedFinalState: { kind: "idle" },
    });
  });

  it("user_stop during launching → idle", () => {
    runTrace({
      name: "user_stop while launching",
      events: [launch(1, 1000), { type: "user_stop" }],
      expectedFinalState: { kind: "idle" },
    });
  });

  it("process_exited during launching → idle", () => {
    runTrace({
      name: "process_exited while launching",
      events: [launch(1, 1000), { type: "process_exited", code: 1, signal: null }],
      expectedFinalState: { kind: "idle" },
    });
  });

  it("user_stop from socket-ready → idle", () => {
    runTrace({
      name: "user_stop from socket-ready",
      events: [launch(1, 1000), { type: "socket_ready" }, { type: "user_stop" }],
      expectedFinalState: { kind: "idle" },
    });
  });

  it("process_exited from socket-ready → idle", () => {
    runTrace({
      name: "process_exited from socket-ready",
      events: [
        launch(1, 1000),
        { type: "socket_ready" },
        { type: "process_exited", code: 0, signal: null },
      ],
      expectedFinalState: { kind: "idle" },
    });
  });

  it("socket-ready is idempotent — duplicate socket_ready / stray socket_failed are no-ops", () => {
    runTrace({
      name: "socket-ready idempotent",
      events: [
        launch(1, 1000),
        { type: "socket_ready" },
        { type: "socket_ready" },
        { type: "socket_failed" },
      ],
      expectedFinalState: { kind: "socket-ready", launchId: 1 },
    });
  });

  it("relaunch from launching → launching with the new launchId", () => {
    runTrace({
      name: "relaunch from launching",
      events: [launch(1, 1000), launch(2, 2000)],
      expectedFinalState: { kind: "launching", launchId: 2, startedAt: 2000 },
    });
  });

  it("relaunch from socket-ready → launching with the new launchId", () => {
    runTrace({
      name: "relaunch from socket-ready",
      events: [launch(1, 1000), { type: "socket_ready" }, launch(2, 2000)],
      expectedFinalState: { kind: "launching", launchId: 2, startedAt: 2000 },
    });
  });

  it("idle ignores non-launch events (socket_ready / socket_failed / process_exited / user_stop)", () => {
    for (const event of [
      { type: "socket_ready" },
      { type: "socket_failed" },
      { type: "process_exited", code: null, signal: "SIGKILL" },
      { type: "user_stop" },
    ] satisfies LifecycleEvent[]) {
      runTrace({
        name: `idle no-op ${event.type}`,
        events: [event],
        expectedFinalState: { kind: "idle" },
      });
    }
  });

  // -------------------------------------------------------------------------
  // Forward-compat: `playing` is retained but unreached by current producers.
  // Pin its teardown behavior directly (no event sequence reaches it).
  // -------------------------------------------------------------------------

  it("playing + user_stop → stopping (forward-compat)", () => {
    console.info(`[lifecycle-traces:forward-compat] playing + user_stop`);
    expectReduce(
      "playing-user_stop",
      { kind: "playing", launchId: 3 },
      { type: "user_stop" },
      { kind: "stopping" },
    );
  });

  it("playing + process_exited → idle (forward-compat)", () => {
    console.info(`[lifecycle-traces:forward-compat] playing + process_exited`);
    expectReduce(
      "playing-process_exited",
      { kind: "playing", launchId: 3 },
      { type: "process_exited", code: 0, signal: null },
      { kind: "idle" },
    );
  });

  it("playing ignores socket_ready / socket_failed (forward-compat)", () => {
    console.info(`[lifecycle-traces:forward-compat] playing ignores socket_ready/socket_failed`);
    const playing: LifecycleState = { kind: "playing", launchId: 3 };
    expectReduce("playing-ignore-socket_ready", playing, { type: "socket_ready" }, playing);
    expectReduce("playing-ignore-socket_failed", playing, { type: "socket_failed" }, playing);
  });

  it("stopping → idle on process_exited; ignores socket_ready / socket_failed / user_stop", () => {
    console.info(`[lifecycle-traces:forward-compat] stopping transition matrix`);
    const stopping: LifecycleState = { kind: "stopping" };
    expectReduce("stopping-ignore-socket_ready", stopping, { type: "socket_ready" }, stopping);
    expectReduce("stopping-ignore-socket_failed", stopping, { type: "socket_failed" }, stopping);
    expectReduce("stopping-ignore-user_stop", stopping, { type: "user_stop" }, stopping);
    expectReduce(
      "stopping-process_exited",
      stopping,
      { type: "process_exited", code: 0, signal: null },
      { kind: "idle" },
    );
  });

  it("launch_started resets to launching from any state (playing / stopping)", () => {
    console.info(`[lifecycle-traces:forward-compat] launch_started resets from playing/stopping`);
    expectReduce(
      "reset-from-playing",
      { kind: "playing", launchId: 1 },
      launch(5, 5000),
      { kind: "launching", launchId: 5, startedAt: 5000 },
    );
    expectReduce(
      "reset-from-stopping",
      { kind: "stopping" },
      launch(6, 6000),
      { kind: "launching", launchId: 6, startedAt: 6000 },
    );
  });
});
