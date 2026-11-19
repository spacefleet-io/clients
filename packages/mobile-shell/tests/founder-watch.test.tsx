/**
 * @test-id MOBILE-SHELL-FOUNDER-WATCH-001
 * @level unit
 * @req WAIT-FOUND-04[badger-mobile,badger-tv,parrot]
 * @why Founder launch 2026-11-18: a founder must never wonder "what about my discount?". The phone and TV shells ask
 *   `GET /account/founder` at start / sign-in (always) and on each return to the foreground (throttled); the first answer
 *   with `noticePending` hands the one-time "Founder ticket recognised" notice to the shell exactly once, and however the
 *   notice leaves the shell calls `noticeSeen`, which POSTs `/account/founder/notice-seen`. A failed POST is retried on
 *   the next refresh without showing the notice twice; another account (or sign-out) starts over. The badge reads
 *   "Founder 🎫 · since the waitlist, {date}" and the notice "🎫 {bannerTitle}" / {bannerBody} in the account's language.
 */
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FounderStatusResponse } from "@space/shared/founder";
import {
  createFounderWatch,
  FOUNDER_REFRESH_THROTTLE_MS,
  founderBadgeText,
  founderNoticeText,
  useFounderStatus,
  useFounderWatch,
} from "../src/founder";

const appStateListeners = vi.hoisted(() => new Set<(state: string) => void>());
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    },
  },
}));
vi.mock("@space/shared/api", () => ({
  getFounderStatus: vi.fn(),
  markFounderNoticeSeen: vi.fn(),
}));
vi.mock("../src/logger", () => ({ scopeLogger: () => ({ warn: () => undefined, info: () => undefined }) }));

const TEST_ID = "MOBILE-SHELL-FOUNDER-WATCH-001";
const log = (...args: unknown[]) => console.info(`[${TEST_ID}]`, ...args);

const SINCE = "2026-03-03T10:00:00.000Z";
const PENDING: FounderStatusResponse = { founder: true, since: SINCE, noticePending: true };
const SEEN: FounderStatusResponse = { founder: true, since: SINCE, noticePending: false };
const NOT_FOUNDER: FounderStatusResponse = { founder: false, since: null, noticePending: false };

/** A watch over a fake API: `answers` is what GET returns next (the last one repeats); `seenFails` makes POSTs fail. */
const setup = (answers: FounderStatusResponse[], { seenFails = 0 }: { seenFails?: number } = {}) => {
  let clock = 1_000_000;
  const queue = [...answers];
  const fetched: string[] = [];
  const marked: string[] = [];
  let failures = seenFails;
  const events: string[] = [];
  const watch = createFounderWatch({
    fetchStatus: async (token) => {
      fetched.push(token);
      const answer = queue.length > 1 ? queue.shift()! : queue[0];
      log("GET /account/founder", token, JSON.stringify(answer));
      return answer;
    },
    markSeen: async (token) => {
      marked.push(token);
      if (failures > 0) {
        failures -= 1;
        log("POST notice-seen fails", token);
        throw new Error("offline");
      }
      log("POST notice-seen ok", token);
      return { ok: true };
    },
    now: () => clock,
    log: (event, payload) => {
      events.push(event);
      log("watch:", event, JSON.stringify(payload));
    },
  });
  let notices = 0;
  watch.onNotice(() => {
    notices += 1;
    log("onNotice fired; total", notices);
  });
  return {
    watch,
    fetched,
    marked,
    events,
    notices: () => notices,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

afterEach(() => {
  appStateListeners.clear();
});

describe("createFounderWatch", () => {
  it("announces the pending notice once per account and run, however often it refreshes", async () => {
    const t = setup([PENDING]);
    await t.watch.refresh("tok-a", { force: true });
    await t.watch.refresh("tok-a", { force: true });
    t.advance(FOUNDER_REFRESH_THROTTLE_MS + 1);
    await t.watch.refresh("tok-a");
    log("fetched", t.fetched, "notices", t.notices());
    expect(t.fetched).toEqual(["tok-a", "tok-a", "tok-a"]);
    expect(t.notices()).toBe(1);
    expect(t.watch.get()).toEqual(PENDING);
  });

  it("does not announce for a founder whose notice was already seen, nor for a non-founder", async () => {
    const seen = setup([SEEN]);
    await seen.watch.refresh("tok-a", { force: true });
    const plain = setup([NOT_FOUNDER]);
    await plain.watch.refresh("tok-b", { force: true });
    log("seen notices", seen.notices(), "plain notices", plain.notices());
    expect(seen.notices()).toBe(0);
    expect(seen.watch.get()).toEqual(SEEN);
    expect(plain.notices()).toBe(0);
    expect(plain.watch.get()).toEqual(NOT_FOUNDER);
  });

  it("throttles foreground refreshes but never a forced one (start, sign-in)", async () => {
    const t = setup([SEEN]);
    await t.watch.refresh("tok-a", { force: true });
    t.advance(1_000);
    await t.watch.refresh("tok-a");
    log("after throttled refresh", t.fetched);
    expect(t.fetched).toHaveLength(1);
    expect(t.events).toContain("founder.refresh.throttled");
    await t.watch.refresh("tok-a", { force: true });
    expect(t.fetched).toHaveLength(2);
    t.advance(FOUNDER_REFRESH_THROTTLE_MS);
    await t.watch.refresh("tok-a");
    log("after the throttle window", t.fetched);
    expect(t.fetched).toHaveLength(3);
  });

  it("marks the notice seen on the API and clears noticePending locally", async () => {
    const t = setup([PENDING, SEEN]);
    await t.watch.refresh("tok-a", { force: true });
    await t.watch.noticeSeen("tok-a");
    log("marked", t.marked, "status", JSON.stringify(t.watch.get()));
    expect(t.marked).toEqual(["tok-a"]);
    expect(t.watch.get()?.noticePending).toBe(false);
    expect(t.watch.get()?.founder).toBe(true);
  });

  it("retries a failed seen POST on the next refresh without announcing again", async () => {
    // The API still says pending (it never got the POST) until the retry lands.
    const t = setup([PENDING, PENDING, SEEN], { seenFails: 1 });
    await t.watch.refresh("tok-a", { force: true });
    expect(t.notices()).toBe(1);
    await t.watch.noticeSeen("tok-a");
    expect(t.events).toContain("founder.seen.failed");
    t.advance(FOUNDER_REFRESH_THROTTLE_MS + 1);
    await t.watch.refresh("tok-a");
    log("marked", t.marked, "notices", t.notices(), "status", JSON.stringify(t.watch.get()));
    expect(t.marked).toEqual(["tok-a", "tok-a"]);
    expect(t.notices()).toBe(1);
    expect(t.watch.get()?.noticePending).toBe(false);
  });

  it("ignores a seen call for another account", async () => {
    const t = setup([PENDING]);
    await t.watch.refresh("tok-a", { force: true });
    await t.watch.noticeSeen("tok-old");
    log("marked", t.marked);
    expect(t.marked).toEqual([]);
  });

  it("starts over for another account and forgets on sign-out", async () => {
    const t = setup([PENDING]);
    await t.watch.refresh("tok-a", { force: true });
    await t.watch.refresh("tok-b");
    log("after account change: fetched", t.fetched, "notices", t.notices());
    // A new account asks at once (no throttle carried over) and gets its own one-time notice.
    expect(t.fetched).toEqual(["tok-a", "tok-b"]);
    expect(t.notices()).toBe(2);
    t.watch.reset();
    log("after reset", JSON.stringify(t.watch.get()));
    expect(t.watch.get()).toBeNull();
  });

  it("drops an answer that arrives after the account changed", async () => {
    const late = Promise.withResolvers<FounderStatusResponse>();
    const watch = createFounderWatch({
      fetchStatus: (token) => (token === "tok-a" ? late.promise : Promise.resolve(NOT_FOUNDER)),
      markSeen: async () => ({ ok: true }),
    });
    let notices = 0;
    watch.onNotice(() => (notices += 1));
    const first = watch.refresh("tok-a", { force: true });
    await watch.refresh("tok-b", { force: true });
    late.resolve(PENDING);
    await first;
    log("status after a late answer", JSON.stringify(watch.get()), "notices", notices);
    expect(watch.get()).toEqual(NOT_FOUNDER);
    expect(notices).toBe(0);
  });

  it("hands a still-due notice to a shell that starts listening late, never one already dismissed", async () => {
    // Seen on Badger TV 2026-11-18: the answer arrived while no shell listened (or the shell that got it was replaced
    // before showing it), so the notice never appeared. A shell that listens while it is still due gets it at once.
    const watch = createFounderWatch({
      fetchStatus: async () => PENDING,
      markSeen: async () => ({ ok: true }),
      log: (event, payload) => log("watch:", event, JSON.stringify(payload)),
    });
    await watch.refresh("tok-a", { force: true });
    let first = 0;
    const stopFirst = watch.onNotice(() => (first += 1));
    log("first shell after listening late:", first);
    expect(first).toBe(1);
    await watch.refresh("tok-a", { force: true });
    expect(first).toBe(1);

    // The first shell goes away before the notice was dismissed: its replacement shows it.
    stopFirst();
    let second = 0;
    const stopSecond = watch.onNotice(() => (second += 1));
    log("replacement shell:", second);
    expect(second).toBe(1);

    // Dismissed there: a later shell does not show it again.
    await watch.noticeSeen("tok-a");
    stopSecond();
    let third = 0;
    watch.onNotice(() => (third += 1));
    log("shell after dismissal:", third);
    expect(third).toBe(0);
  });
});

describe("useFounderWatch / useFounderStatus", () => {
  it("asks on sign-in, on a return to the foreground (throttled), and forgets on sign-out", async () => {
    const t = setup([PENDING, SEEN]);
    const onNotice = vi.fn();
    const seenStatus: Array<FounderStatusResponse | null> = [];
    const Probe = ({ token }: { token: string | null }) => {
      useFounderWatch(token, onNotice, t.watch);
      seenStatus.push(useFounderStatus(t.watch));
      return null;
    };
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Probe token="tok-a" />);
    });
    log("after mount: fetched", t.fetched, "onNotice calls", onNotice.mock.calls.length, "appState listeners", appStateListeners.size);
    expect(t.fetched).toEqual(["tok-a"]);
    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(seenStatus.at(-1)).toEqual(PENDING);
    expect(appStateListeners.size).toBe(1);

    // Back to the foreground at once: throttled. After the window: asks again.
    await act(async () => {
      for (const listener of appStateListeners) listener("active");
    });
    expect(t.fetched).toHaveLength(1);
    t.advance(FOUNDER_REFRESH_THROTTLE_MS + 1);
    await act(async () => {
      for (const listener of appStateListeners) listener("background");
      for (const listener of appStateListeners) listener("active");
    });
    log("after foreground return: fetched", t.fetched, "status", JSON.stringify(seenStatus.at(-1)));
    expect(t.fetched).toHaveLength(2);
    expect(seenStatus.at(-1)).toEqual(SEEN);
    expect(onNotice).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.update(<Probe token={null} />);
    });
    log("after sign-out: status", JSON.stringify(seenStatus.at(-1)), "appState listeners", appStateListeners.size);
    expect(seenStatus.at(-1)).toBeNull();
    expect(appStateListeners.size).toBe(0);
    act(() => renderer.unmount());
  });
});

describe("founder copy on the phone and TV", () => {
  it("badge reads 'Founder 🎫 · since the waitlist, {date}' and drops the date when there is none", () => {
    const en = founderBadgeText("en", SINCE);
    const fr = founderBadgeText("fr", SINCE);
    const noDate = founderBadgeText("en", null);
    log("badge en:", en, "| fr:", fr, "| no date:", noDate);
    expect(en).toMatch(/^Founder 🎫 · since the waitlist, (March 3, 2026|3 March 2026)$/);
    expect(fr.startsWith("Fondateur 🎫 · depuis la liste d'attente, ")).toBe(true);
    expect(fr).toContain("2026");
    expect(noDate).toBe("Founder 🎫");
  });

  it("notice reads '🎫 {bannerTitle}' over {bannerBody}, with no deadline and the French 'offre'", () => {
    const en = founderNoticeText("en");
    const fr = founderNoticeText("fr");
    log("notice en:", JSON.stringify(en), "| fr:", JSON.stringify(fr));
    expect(en).toEqual({
      title: "🎫 Founder ticket recognised.",
      body: "Your 30% for life is applied to your plan.",
      dismiss: "Got it",
    });
    expect(fr.title).toBe("🎫 Remise fondateur reconnue.");
    expect(fr.body).toContain("offre");
    for (const text of [en, fr].flatMap((copy) => Object.values(copy))) {
      expect(text).not.toMatch(/formule|300|7 days|7 jours/i);
    }
  });
});
