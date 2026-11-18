/**
 * @test-id MOBILE-CAST-006
 * @level unit
 * @why Starting the Google Cast session (UX-TV-03): a live session to the same device is reused, one to another device is
 *   ended first, and a start that fails (by event or by `startSession` rejecting) rejects the cast and leaves no listener.
 *   A start that never settles (the selected route vanished, seen on a Google TV) times out, and one whose screen closed
 *   aborts, so its listeners cannot take the next session for their own and end it (seen on a OnePlus 9 Pro).
 *   The load switches the subtitle on after `loadMedia`, because react-native-google-cast drops `activeTrackIds` on Android.
 */
import { describe, expect, it, vi } from "vitest";
import {
  connectGoogleSession,
  loadGoogleMedia,
  type GoogleMediaClientLike,
  type GoogleSessionLike,
  type GoogleSessionManager,
} from "../src/lib/cast/googleSession";

type FakeSession = GoogleSessionLike & { id: string };

/** A session manager that keeps its listeners like the real one and lets a test decide how `startSession` ends. */
const fakeManager = (opts: { current?: FakeSession | null; start: (emit: { started: (s: FakeSession) => void; failed: (e: string) => void }) => Promise<void> }) => {
  const started = new Set<(s: FakeSession) => void>();
  const failed = new Set<(s: FakeSession, e: string) => void>();
  let current = opts.current ?? null;
  const manager: GoogleSessionManager<FakeSession> = {
    getCurrentCastSession: async () => current,
    endCurrentSession: async () => {
      current = null;
      return true;
    },
    startSession: () =>
      opts.start({
        started: (s) => [...started].forEach((l) => l(s)),
        failed: (e) => [...failed].forEach((l) => l({ id: "none", getCastDevice: async () => null }, e)),
      }),
    onSessionStarted: (l) => {
      started.add(l);
      return { remove: () => void started.delete(l) };
    },
    onSessionStartFailed: (l) => {
      failed.add(l);
      return { remove: () => void failed.delete(l) };
    },
  };
  return { manager, listeners: () => started.size + failed.size, current: () => current };
};

const session = (id: string, deviceId: string): FakeSession => ({ id, getCastDevice: async () => ({ deviceId }) });

describe("connectGoogleSession", () => {
  // @req UX-TV-03[badger-mobile]
  it("reuses a live session to the same device without starting another", async () => {
    const live = session("live", "tv-1");
    const fake = fakeManager({ current: live, start: async () => Promise.reject(new Error("must not start")) });
    await expect(connectGoogleSession(fake.manager, "tv-1")).resolves.toBe(live);
  });

  // @req UX-TV-03[badger-mobile]
  it("ends a session to another device, then resolves with the new one and leaves no listener", async () => {
    const next = session("next", "tv-2");
    const fake = fakeManager({
      current: session("old", "tv-1"),
      start: async (emit) => {
        queueMicrotask(() => emit.started(next));
      },
    });
    await expect(connectGoogleSession(fake.manager, "tv-2")).resolves.toBe(next);
    expect(fake.current()).toBeNull();
    expect(fake.listeners()).toBe(0);
  });

  // @req UX-TV-03[badger-mobile]
  it("rejects with the Cast error when the session fails to start, and leaves no listener", async () => {
    const fake = fakeManager({
      start: async (emit) => {
        queueMicrotask(() => emit.failed("session_start_failed"));
      },
    });
    await expect(connectGoogleSession(fake.manager, "tv-1")).rejects.toThrow("session_start_failed");
    expect(fake.listeners()).toBe(0);
  });

  // @req UX-TV-03[badger-mobile]
  it("rejects and leaves no listener when startSession itself rejects", async () => {
    const fake = fakeManager({ start: async () => Promise.reject(new Error("no_such_device")) });
    await expect(connectGoogleSession(fake.manager, "tv-9")).rejects.toThrow("no_such_device");
    expect(fake.listeners()).toBe(0);
  });

  // @req UX-TV-03[badger-mobile]
  it("rejects with session_start_timeout and leaves no listener when the start neither starts nor fails", async () => {
    const fake = fakeManager({ start: async () => undefined });
    await expect(connectGoogleSession(fake.manager, "tv-1", { timeoutMs: 5 })).rejects.toThrow("session_start_timeout");
    expect(fake.listeners()).toBe(0);
  });

  // @req UX-TV-03[badger-mobile]
  it("on abort rejects and drops its listeners, so the next attempt's session goes to the next attempt only", async () => {
    const starts: Array<{ started: (s: FakeSession) => void }> = [];
    const fake = fakeManager({
      start: async (e) => {
        starts.push(e);
      },
    });
    const closed = new AbortController();
    const first = connectGoogleSession(fake.manager, "tv-1", { signal: closed.signal });
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    closed.abort();
    await expect(first).rejects.toThrow("cast_aborted");
    expect(fake.listeners()).toBe(0);

    const next = session("next", "tv-1");
    const second = connectGoogleSession(fake.manager, "tv-1");
    await vi.waitFor(() => expect(starts).toHaveLength(2));
    starts[1]!.started(next);
    await expect(second).resolves.toBe(next);
    expect(fake.listeners()).toBe(0);
  });

  // @req UX-TV-03[badger-mobile]
  it("does not start a session when the screen closed before the start", async () => {
    const fake = fakeManager({ start: async () => Promise.reject(new Error("must not start")) });
    const closed = new AbortController();
    closed.abort();
    await expect(connectGoogleSession(fake.manager, "tv-1", { signal: closed.signal })).rejects.toThrow("cast_aborted");
    expect(fake.listeners()).toBe(0);
  });
});

type LoadRequest = { contentUrl: string; activeTrackIds?: number[] };

/** A media client that records the order of the calls the load makes; `setActiveTrackIds` can be made to fail. */
const fakeClient = (opts: { trackSwitchFails?: boolean } = {}) => {
  const calls: string[] = [];
  const client: GoogleMediaClientLike<LoadRequest> = {
    loadMedia: async (request) => {
      calls.push(`load ${request.contentUrl} active=${JSON.stringify(request.activeTrackIds ?? null)}`);
    },
    setActiveTrackIds: async (ids) => {
      calls.push(`active ${JSON.stringify(ids)}`);
      if (opts.trackSwitchFails) throw new Error("no_media_session");
    },
  };
  return { client, calls };
};

describe("loadGoogleMedia", () => {
  // @req UX-TV-03[badger-mobile]
  it("switches the subtitle track on after the load, so Android (which drops activeTrackIds) shows it too", async () => {
    const fake = fakeClient();
    await loadGoogleMedia(fake.client, { contentUrl: "http://10.0.0.2/cast/t/master.m3u8", activeTrackIds: [1] }, 1);
    console.info("[MOBILE-CAST-006] calls", JSON.stringify(fake.calls));
    expect(fake.calls).toEqual(["load http://10.0.0.2/cast/t/master.m3u8 active=[1]", "active [1]"]);
  });

  // @req UX-TV-03[badger-mobile]
  it("does not touch the tracks when the cast carries no subtitle", async () => {
    const fake = fakeClient();
    await loadGoogleMedia(fake.client, { contentUrl: "http://10.0.0.2/cast/t/master.m3u8" }, null);
    console.info("[MOBILE-CAST-006] calls", JSON.stringify(fake.calls));
    expect(fake.calls).toEqual(["load http://10.0.0.2/cast/t/master.m3u8 active=null"]);
  });

  // @req UX-TV-03[badger-mobile]
  it("keeps the cast going when the subtitle switch fails", async () => {
    const fake = fakeClient({ trackSwitchFails: true });
    await expect(loadGoogleMedia(fake.client, { contentUrl: "http://10.0.0.2/cast/t/master.m3u8", activeTrackIds: [1] }, 1)).resolves.toBeUndefined();
    console.info("[MOBILE-CAST-006] calls", JSON.stringify(fake.calls));
    expect(fake.calls).toEqual(["load http://10.0.0.2/cast/t/master.m3u8 active=[1]", "active [1]"]);
  });
});
