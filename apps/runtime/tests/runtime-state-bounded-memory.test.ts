/**
 * spacefleet #25 — runtime RSS growth under ultimate stress runs.
 *
 * Root cause (measured with a standalone runtime driven by the desktop's
 * command mix, see the PR): `RuntimeState` kept EVERY command response in a
 * per-token idempotency map for the whole token lifetime (1 h by default),
 * including every `badger.db.snapshot` result (~1 MB library snapshot each).
 * The desktop pulls a snapshot after every library write, so RSS grew by
 * roughly one snapshot per write. A second, bounded-but-large holder was the
 * in-memory event ring: up to 500 `badger.library.updated` frames, each with
 * its own full snapshot.
 *
 * These tests drive the public RuntimeState API with far more traffic than
 * any bound and assert the retained structures stay bounded. No RSS
 * assertions: the structure sizes are deterministic, RSS is not.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeState } from "../src/state";
import type { RuntimeCommandResponse } from "../src/types";

const TAG = "[runtime-state-bounded-memory]";
const SLICES = "/tmp/spacefleet-runtime-slices-bounded-memory";

const response = (requestId: string, bytes = 64): RuntimeCommandResponse => ({
  requestId,
  ok: true,
  result: { blob: "x".repeat(bytes) },
  error: null,
});

const dump = (label: string, state: RuntimeState, extra: Record<string, unknown> = {}) => {
  // Tolerates a RuntimeState without getMemoryStats so the pre-fix run fails
  // on the behavioural assertions, not on this log line.
  const stats = typeof state.getMemoryStats === "function" ? state.getMemoryStats() : "unavailable";
  console.info(`${TAG} ${label} stats=${JSON.stringify(stats)} extra=${JSON.stringify(extra)}`);
};

afterEach(() => {
  vi.useRealTimers();
});

describe("RuntimeState bounded memory (#25)", () => {
  it("@bugfix @regression-proof caps the command idempotency cache regardless of traffic @req RT-CMD-04", () => {
    const state = new RuntimeState(60 * 60 * 1000, 500, "1", SLICES);
    const { token } = state.login("backend", ["badger"]);
    const total = 10_000;
    console.info(`${TAG} idem-cap: caching ${total} responses on one token`);
    for (let i = 0; i < total; i += 1) {
      state.setCachedResult(token, `req-${i}`, response(`req-${i}`));
      if (i % 2_500 === 0) dump(`idem-cap i=${i}`, state);
    }
    dump("idem-cap done", state);
    // Oldest entries are the ones evicted; the newest are still replayable.
    expect(state.getCachedResult(token, "req-0")).toBeNull();
    expect(state.getCachedResult(token, `req-${total - 1}`)?.requestId).toBe(`req-${total - 1}`);
    expect(state.getMemoryStats().idempotencyEntries).toBeLessThanOrEqual(RuntimeState.IDEMPOTENCY_MAX_ENTRIES);
  });

  it("@bugfix @regression-proof caps the idempotency cache across many tokens", () => {
    const state = new RuntimeState(60 * 60 * 1000, 500, "1", SLICES);
    for (let t = 0; t < 200; t += 1) {
      const { token } = state.login(`backend-${t}`, ["badger"]);
      for (let i = 0; i < 50; i += 1) state.setCachedResult(token, `req-${i}`, response(`req-${i}`));
    }
    dump("idem-multi-token done", state);
    expect(state.getMemoryStats().idempotencyEntries).toBeLessThanOrEqual(RuntimeState.IDEMPOTENCY_MAX_ENTRIES);
  });

  it("@bugfix @regression-proof keeps duplicate-requestId replay inside the TTL window and drops it after @req RT-CMD-04", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T10:00:00Z"));
    const state = new RuntimeState(60 * 60 * 1000, 500, "1", SLICES);
    const { token } = state.login("backend", ["badger"]);
    state.setCachedResult(token, "dup", response("dup"));
    vi.advanceTimersByTime(RuntimeState.IDEMPOTENCY_TTL_MS - 1_000);
    const inside = state.getCachedResult(token, "dup");
    dump("idem-ttl inside window", state, { hit: inside !== null });
    expect(inside?.requestId).toBe("dup");
    vi.advanceTimersByTime(2_000);
    const after = state.getCachedResult(token, "dup");
    dump("idem-ttl after window", state, { hit: after !== null });
    expect(after).toBeNull();
    expect(state.getMemoryStats().idempotencyEntries).toBe(0);
  });

  it("keeps cached results scoped to their token and drops them on logout (semantics guard for the flat cache)", () => {
    const state = new RuntimeState(60 * 60 * 1000, 500, "1", SLICES);
    const a = state.login("a", ["badger"]).token;
    const b = state.login("b", ["badger"]).token;
    state.setCachedResult(a, "same-id", response("from-a"));
    expect(state.getCachedResult(b, "same-id")).toBeNull();
    expect(state.getCachedResult(a, "same-id")?.requestId).toBe("from-a");
    state.logout(a);
    dump("idem-logout", state);
    expect(state.getCachedResult(a, "same-id")).toBeNull();
    expect(state.getMemoryStats().idempotencyEntries).toBe(0);
  });

  it("@bugfix @regression-proof sweeps expired sessions that are never used again", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T10:00:00Z"));
    const ttl = 60_000;
    const state = new RuntimeState(ttl, 500, "1", SLICES);
    for (let i = 0; i < 100; i += 1) state.login(`stale-${i}`, ["badger"]);
    dump("sessions before expiry", state);
    vi.advanceTimersByTime(ttl + 1);
    state.login("fresh", ["badger"]);
    dump("sessions after expiry + fresh login", state);
    expect(state.getMemoryStats().sessions).toBe(1);
  });

  it("@bugfix @regression-proof retains at most one full library snapshot in the in-memory event ring", () => {
    const state = new RuntimeState(60 * 60 * 1000, 500, "1", SLICES);
    const live: unknown[] = [];
    state.addSubscriber("sub", state.login("tok-backend", ["badger"]).token, (frame) => {
      if (frame.event === "badger.library.updated") live.push(frame.payload.snapshot);
    });
    state.applyClientFrame("sub", { type: "subscribe", apps: ["badger"], channels: ["badger.library"] });
    const publishes = 300;
    for (let v = 1; v <= publishes; v += 1) {
      state.publish("badger", "library", "library.updated", {
        version: v,
        reason: "setProgress",
        mediaCount: 1,
        playlistCount: 0,
        snapshot: { version: v, media: [{ id: "m", blob: "y".repeat(1024) }] },
      });
    }
    // Live subscribers still receive every full snapshot at publish time.
    expect(live).toHaveLength(publishes);
    expect(live.every((s) => s !== undefined)).toBe(true);

    const replay = state.applyClientFrame("sub", { type: "ack", lastEventId: "unknown-id" });
    const withSnapshot = replay.filter((f) => "snapshot" in f.payload);
    dump("ring", state, { replay: replay.length, withSnapshot: withSnapshot.length });
    expect(replay).toHaveLength(publishes);
    expect(withSnapshot).toHaveLength(1);
    // The one kept is the newest, so a reconnecting consumer still sees current state.
    expect(withSnapshot[0]?.payload.version).toBe(publishes);
    // Older frames keep their version/reason metadata for the play-button gate.
    expect(replay[0]?.payload.version).toBe(1);
    expect(replay[0]?.payload.reason).toBe("setProgress");
    expect(state.getMemoryStats().retainedLibrarySnapshots).toBe(1);
  });
});
