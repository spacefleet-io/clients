/**
 * @test-id MOBILE-META-TICKETS-001
 * @level unit
 * When the anonymous-ticket reserve runs on the phone: started once signed in and in the foreground, stopped in the
 * background and at sign-out, erased at sign-out (after a refill already on the wire has landed).
 */
import { describe, expect, it, vi } from "vitest";
import { createTicketLifecycle, type TicketLifecycleDeps } from "../src/lib/metadata/tickets";

const SUITE = "mobile-meta-tickets";

const harness = (extra: Partial<Pick<TicketLifecycleDeps, "defer" | "onResume">> = {}) => {
  const calls: string[] = [];
  let releaseRefill: (() => void) | null = null;
  const reserve = {
    start: vi.fn(async () => {
      calls.push("start");
      return { status: "ok" as const, added: 0, dropped: 0, count: 0 };
    }),
    stop: vi.fn(() => {
      calls.push("stop");
    }),
    // Stands for a batch that was already sent when the user signed out.
    refill: vi.fn(async () => {
      calls.push("refill:wait");
      await new Promise<void>((resolve) => {
        releaseRefill = resolve;
      });
      calls.push("refill:done");
      return { status: "stopped" as const, added: 0, dropped: 0, count: 0 };
    }),
  };
  const tokens: Array<string | null> = [];
  const lifecycle = createTicketLifecycle({
    reserve,
    setSessionToken: (token) => tokens.push(token),
    eraseOnSignOut: async () => {
      calls.push("erase");
    },
    ...extra,
  });
  return { calls, reserve, tokens, lifecycle, release: () => releaseRefill?.() };
};

describe("ticket lifecycle", () => {
  // @req META-ANON-02
  it("starts the reserve after sign-in and again on foreground, stops it in the background", async () => {
    console.info(`[${SUITE}:foreground] arranging: signed-in session, app in foreground`);
    const h = harness();
    h.lifecycle.setSessionToken("session-token");
    await h.lifecycle.settled();
    expect(h.calls).toEqual(["start"]);

    console.info(`[${SUITE}:foreground] acting: background, then foreground`);
    h.lifecycle.setForeground(false);
    await h.lifecycle.settled();
    h.lifecycle.setForeground(true);
    await h.lifecycle.settled();
    expect(h.calls).toEqual(["start", "stop", "stop", "start"]);
    expect(h.tokens).toEqual(["session-token"]);
    expect(h.reserve.refill).not.toHaveBeenCalled();
  });

  // @req META-ANON-02
  it("does not start the reserve while signed out, nor in the background", async () => {
    console.info(`[${SUITE}:idle] arranging: nobody signed in`);
    const h = harness();
    h.lifecycle.setForeground(false);
    h.lifecycle.setForeground(true);
    await h.lifecycle.settled();
    expect(h.reserve.start).not.toHaveBeenCalled();

    console.info(`[${SUITE}:idle] acting: sign in while in the background`);
    h.lifecycle.setForeground(false);
    h.lifecycle.setSessionToken("session-token");
    await h.lifecycle.settled();
    expect(h.reserve.start).not.toHaveBeenCalled();

    h.lifecycle.setForeground(true);
    await h.lifecycle.settled();
    expect(h.reserve.start).toHaveBeenCalledTimes(1);
  });

  // @req META-ANON-02
  it("stops at once on sign-out, lets a batch on the wire land, then erases the stored tickets", async () => {
    console.info(`[${SUITE}:sign-out] arranging: running reserve with a refill on the wire`);
    const h = harness();
    h.lifecycle.setSessionToken("session-token");
    await h.lifecycle.settled();
    h.calls.length = 0;

    console.info(`[${SUITE}:sign-out] acting: sign out`);
    h.lifecycle.setSessionToken(null);
    expect(h.calls).toEqual(["stop"]);
    expect(h.tokens).toEqual(["session-token", null]);

    await vi.waitFor(() => expect(h.calls).toEqual(["stop", "refill:wait"]));
    expect(h.calls).not.toContain("erase");
    h.release();
    await h.lifecycle.settled();
    expect(h.calls).toEqual(["stop", "refill:wait", "refill:done", "erase"]);
  });

  // @req META-ANON-02
  it("a quick sign-in after sign-out erases the old tickets first and then starts for the new session", async () => {
    console.info(`[${SUITE}:relogin] arranging: signed in, then out and in again before the erase ran`);
    const h = harness();
    h.lifecycle.setSessionToken("first");
    await h.lifecycle.settled();
    h.calls.length = 0;

    h.lifecycle.setSessionToken(null);
    h.lifecycle.setSessionToken("second");
    await h.lifecycle.settled();
    // The drain skips refill() because a new session exists (that refill is the new session's start, not ours).
    expect(h.calls).toEqual(["stop", "erase", "start"]);
    expect(h.reserve.refill).not.toHaveBeenCalled();
    expect(h.tokens).toEqual(["first", null, "second"]);
  });

  it("ignores a repeated state without touching the reserve", async () => {
    console.info(`[${SUITE}:repeat] arranging: same token and same foreground state twice`);
    const h = harness();
    h.lifecycle.setSessionToken("session-token");
    h.lifecycle.setSessionToken("session-token");
    h.lifecycle.setForeground(true);
    await h.lifecycle.settled();
    expect(h.reserve.start).toHaveBeenCalledTimes(1);
    expect(h.reserve.stop).not.toHaveBeenCalled();
  });

  // @req META-ANON-02
  it("a start deferred until the interactions are done is dropped when the app went to the background or signed out first", async () => {
    console.info(`[${SUITE}:defer] arranging: starts are deferred, none has run yet`);
    const deferred: Array<() => void> = [];
    const h = harness({ defer: (run) => void deferred.push(run) });

    h.lifecycle.setSessionToken("session-token");
    await h.lifecycle.settled();
    expect(h.reserve.start).not.toHaveBeenCalled();

    console.info(`[${SUITE}:defer] acting: background before the deferred start fires, then it fires`);
    h.lifecycle.setForeground(false);
    await h.lifecycle.settled();
    deferred.forEach((run) => run());
    expect(h.reserve.start).not.toHaveBeenCalled();

    console.info(`[${SUITE}:defer] acting: back in the foreground, the new start fires, the old one is still dropped`);
    h.lifecycle.setForeground(true);
    await h.lifecycle.settled();
    deferred.forEach((run) => run());
    expect(h.reserve.start).toHaveBeenCalledTimes(1);
  });

  it("tells the artwork loader to try again whenever a start is decided (sign-in, foreground)", async () => {
    console.info(`[${SUITE}:resume] arranging: resume hook`);
    const onResume = vi.fn();
    const h = harness({ onResume });
    h.lifecycle.setSessionToken("session-token");
    await h.lifecycle.settled();
    expect(onResume).toHaveBeenCalledTimes(1);
    h.lifecycle.setForeground(false);
    await h.lifecycle.settled();
    expect(onResume).toHaveBeenCalledTimes(1);
    h.lifecycle.setForeground(true);
    await h.lifecycle.settled();
    expect(onResume).toHaveBeenCalledTimes(2);
  });

  // @req META-ANON-02
  it("erases at cold start when no session is stored (an app killed during sign-out), never while signed in", async () => {
    console.info(`[${SUITE}:cold-start] arranging: no session found at start`);
    const signedOut = harness();
    signedOut.lifecycle.eraseWithoutSession();
    await signedOut.lifecycle.settled();
    expect(signedOut.calls).toEqual(["erase"]);

    console.info(`[${SUITE}:cold-start] arranging: a session exists`);
    const signedIn = harness();
    signedIn.lifecycle.setSessionToken("session-token");
    signedIn.lifecycle.eraseWithoutSession();
    await signedIn.lifecycle.settled();
    expect(signedIn.calls).not.toContain("erase");
  });
});
