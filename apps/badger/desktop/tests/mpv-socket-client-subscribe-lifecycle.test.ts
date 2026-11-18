/**
 * Tier-5 — exercises {@link UnixSocketMpvClient}.subscribeLifecycle()
 * against the public API. Verifies subscriber semantics (initial
 * delivery, multi-subscriber dispatch, unsubscribe, idempotent
 * unsubscribe) without requiring a real mpv binary on the test runner.
 *
 * Spawn-failure path is covered: pointing `start()` at a non-existent
 * binary routes the lifecycle through launching → idle via
 * socket_failed, which is observable through the subscription.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LifecycleState } from "@space/mpv-protocol";

import { UnixSocketMpvClient } from "../src/main/mpvSocketClient";

const uniqueSocketPath = () =>
  join(tmpdir(), `sf-mpv-lifecycle-test-${process.pid}-${Date.now()}.sock`);

// On a lifecycle-transition assertion failure, dump the full observed
// transition sequence + the client's current launchId/cached state so the
// (inherently async) failure path is diagnosable from CI logs alone.
// Wrapped in try/catch so a dump failure can't mask the assertion.
const dumpMpvSocketLifecycleSnapshot = (
  label: string,
  seen: LifecycleState[],
  client: UnixSocketMpvClient,
) => {
  try {
    console.error(`=== [mpv-socket-client-subscribe-lifecycle:${label}] snapshot ===`);
    console.error(`seen.length=${seen.length} kinds=${JSON.stringify(seen.map((s) => s.kind))}`);
    console.error(`seen (full)=${JSON.stringify(seen, null, 2)}`);
    console.error(
      `client launchId=${String(client.getLaunchId())} cached=${JSON.stringify(
        client.__getLifecycleStateForTests(),
      )}`,
    );
  } catch (err) {
    console.error(`(snapshot failed: ${err instanceof Error ? err.message : String(err)})`);
  }
};

describe("UnixSocketMpvClient.subscribeLifecycle (tier-5)", () => {
  let client: UnixSocketMpvClient;

  beforeEach(() => {
    console.info("[mpv-socket-client-subscribe-lifecycle:setup] resetting launchId + constructing fresh client");
    UnixSocketMpvClient.__resetLaunchIdForTests();
    client = new UnixSocketMpvClient();
  });

  afterEach(async () => {
    await client.dispose().catch(() => undefined);
  });

  it("delivers the current state synchronously on subscribe", () => {
    console.info("[mpv-socket-client-subscribe-lifecycle:sync-initial] subscribing, expecting synchronous idle");
    const seen: LifecycleState[] = [];
    const unsub = client.subscribeLifecycle((state) => seen.push(state));
    try {
      expect(seen).toEqual([{ kind: "idle" }]);
    } catch (err) {
      dumpMpvSocketLifecycleSnapshot("sync-initial-assert-failed", seen, client);
      throw err;
    }
    unsub();
  });

  it("multiple subscribers each receive the synchronous initial state", () => {
    console.info("[mpv-socket-client-subscribe-lifecycle:multi-sub] two subscribers, each expecting synchronous idle");
    const a: LifecycleState[] = [];
    const b: LifecycleState[] = [];
    const unsubA = client.subscribeLifecycle((state) => a.push(state));
    const unsubB = client.subscribeLifecycle((state) => b.push(state));
    try {
      expect(a).toEqual([{ kind: "idle" }]);
      expect(b).toEqual([{ kind: "idle" }]);
    } catch (err) {
      dumpMpvSocketLifecycleSnapshot("multi-sub-a-assert-failed", a, client);
      dumpMpvSocketLifecycleSnapshot("multi-sub-b-assert-failed", b, client);
      throw err;
    }
    unsubA();
    unsubB();
  });

  it("unsubscribe is idempotent", () => {
    console.info("[mpv-socket-client-subscribe-lifecycle:idempotent-unsub] double-unsub must not throw");
    const seen: LifecycleState[] = [];
    const unsub = client.subscribeLifecycle((state) => seen.push(state));
    try {
      expect(() => {
        unsub();
        unsub();
      }).not.toThrow();
      expect(seen).toEqual([{ kind: "idle" }]);
    } catch (err) {
      dumpMpvSocketLifecycleSnapshot("idempotent-unsub-assert-failed", seen, client);
      throw err;
    }
  });

  it("a failing-bin start() drives the reducer through launching then settles to a failed state", async () => {
    console.info("[mpv-socket-client-subscribe-lifecycle:failing-bin] starting with a non-existent binary");
    const seen: LifecycleState[] = [];
    client.subscribeLifecycle((state) => seen.push(state));
    // Node's spawn() does NOT throw synchronously for a missing binary
    // (it returns a ChildProcess and emits "error" + "exit" asynchronously),
    // so start() resolves with socketReady: false rather than rejecting.
    const result = await client.start({
      bin: "/this/binary/does/not/exist/spacebadger-mpv-test",
      args: ["--idle"],
      env: process.env,
      socketPath: uniqueSocketPath(),
    });
    console.info(
      `[mpv-socket-client-subscribe-lifecycle:failing-bin] start resolved socketReady=${result.socketReady}; ` +
        `observed transitions=${JSON.stringify(seen.map((s) => s.kind))}`,
    );
    try {
      expect(result.socketReady).toBe(false);
      // First two transitions are deterministic: idle → launching →
      // [terminal] where terminal is either "idle" (process exited fast
      // enough that the exit handler fired during waitForSocket) or
      // remains in launching until socket_failed fires after the timeout.
      expect(seen[0]).toEqual({ kind: "idle" });
      expect(seen[1]).toMatchObject({ kind: "launching" });
      const launching = seen[1];
      if (launching.kind !== "launching") throw new Error("expected launching");
      expect(launching.launchId).toBe(client.getLaunchId());
      // Final state must be either idle (process_exited) or the
      // socket_failed terminal — both routes ultimately bring the
      // reducer back to idle.
      const finalKind = seen[seen.length - 1].kind;
      expect(["idle"]).toContain(finalKind);
    } catch (err) {
      dumpMpvSocketLifecycleSnapshot("failing-bin-assert-failed", seen, client);
      throw err;
    }
  });

  it("__getLifecycleStateForTests exposes the cached state", () => {
    console.info("[mpv-socket-client-subscribe-lifecycle:cached-state] expecting cached idle");
    const cached = client.__getLifecycleStateForTests();
    try {
      expect(cached).toEqual({ kind: "idle" });
    } catch (err) {
      dumpMpvSocketLifecycleSnapshot("cached-state-assert-failed", [cached], client);
      throw err;
    }
  });

  it("late subscribers see the most recent state on subscribe", async () => {
    console.info("[mpv-socket-client-subscribe-lifecycle:late-sub] driving one full cycle via aborted start");
    // Drive the machine through one full cycle by aborting a start.
    await client.start({
      bin: "/this/binary/does/not/exist/spacebadger-mpv-test",
      args: ["--idle"],
      env: process.env,
      socketPath: uniqueSocketPath(),
    });
    const seen: LifecycleState[] = [];
    const unsub = client.subscribeLifecycle((state) => seen.push(state));
    console.info(
      `[mpv-socket-client-subscribe-lifecycle:late-sub] late subscriber observed=${JSON.stringify(
        seen.map((s) => s.kind),
      )}`,
    );
    // Cached state at this point depends on whether the async exit
    // handler has fired yet — both "idle" (after process_exited) and
    // "launching" (before exit handler) are valid intermediate snapshots.
    try {
      expect(seen).toHaveLength(1);
      expect(["idle", "launching"]).toContain(seen[0].kind);
    } catch (err) {
      dumpMpvSocketLifecycleSnapshot("late-sub-assert-failed", seen, client);
      throw err;
    }
    unsub();
  });
});
