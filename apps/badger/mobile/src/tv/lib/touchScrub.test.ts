import { describe, expect, it } from "vitest";
import {
  IDLE_SCRUB,
  SCRUB_BASE_SECONDS_PER_POINT,
  SCRUB_COMMIT_WINDOW_MS,
  SCRUB_GESTURE_STALE_MS,
  SCRUB_MAX_SECONDS_PER_POINT,
  SCRUB_START_POINTS,
  panFromEvent,
  scrubCancel,
  scrubPan,
  scrubPending,
  scrubSecondsPerPoint,
  scrubSelect,
  scrubTick,
  scrubTickDelay,
  type Pan,
  type ScrubEffect,
  type ScrubEnv,
  type TouchScrub,
} from "./touchScrub";

const TAG = "[TV-SCRUB]";
const log = (id: string, phase: string, data?: unknown) => console.info(`${TAG}[${id}] phase=${phase}`, data === undefined ? "" : JSON.stringify(data));

/** A 2 h film playing at 10 min, bare video on screen. */
const ENV: ScrubEnv = { now: 0, position: 600, duration: 7200, canScrub: true };

const pan = (state: string, x: number, velocityX = 0, y = 0, velocityY = 0): Pan => ({ state, x, y, velocityX, velocityY });

/** Feeds a gesture's pans, logging every step; returns the final state and every effect in order. */
const feed = (id: string, start: TouchScrub, pans: { pan: Pan; env?: Partial<ScrubEnv> }[]) => {
  let state = start;
  const effects: ScrubEffect[] = [];
  for (const { pan: p, env } of pans) {
    const out = scrubPan(state, p, { ...ENV, ...env });
    log(id, "pan", { pan: p, env, effects: out.effects, target: out.state.target, gesture: out.state.gesture });
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
};

/** One horizontal swipe of `points` (sign = direction) at a steady `speed` (points/s), in `steps` moves, from `at` ms. */
const swipe = (points: number, speed: number, at: number, steps = 10) => {
  const pans: { pan: Pan; env?: Partial<ScrubEnv> }[] = [{ pan: pan("Began", 0, 0), env: { now: at } }];
  const velocity = Math.sign(points) * speed;
  const stepMs = Math.max(1, Math.round((Math.abs(points) / speed) * 1000 / steps));
  for (let i = 1; i <= steps; i += 1) pans.push({ pan: pan("Changed", Math.round((points * i) / steps), velocity), env: { now: at + i * stepMs } });
  pans.push({ pan: pan("Ended", points, velocity), env: { now: at + steps * stepMs + 1 } });
  return { pans, endAt: at + steps * stepMs + 1 };
};

describe("TV touch scrub: speed curve", () => {
  // @req UX-TV-01[badger-tv]
  it("[TV-SCRUB-CURVE-001] seconds per point grow smoothly with the finger's speed, from the base rate to the cap", () => {
    const speeds = [0, 100, 300, 600, 1000, 1500, 2500, 4000, 6000, 9000, 20000, 100000];
    const rates = speeds.map((speed) => scrubSecondsPerPoint(speed));
    log("CURVE-001", "rates", speeds.map((speed, i) => ({ speed, secondsPerPoint: rates[i] })));
    expect(rates[0]).toBeCloseTo(SCRUB_BASE_SECONDS_PER_POINT, 6);
    for (let i = 1; i < rates.length; i += 1) expect(rates[i]).toBeGreaterThanOrEqual(rates[i - 1]);
    expect(rates[rates.length - 1]).toBeCloseTo(SCRUB_MAX_SECONDS_PER_POINT, 6);
    // Direction does not matter, only speed; nonsense is the base rate.
    expect(scrubSecondsPerPoint(-3000)).toBe(scrubSecondsPerPoint(3000));
    expect(scrubSecondsPerPoint(Number.NaN)).toBe(SCRUB_BASE_SECONDS_PER_POINT);
  });

  // @req UX-TV-01[badger-tv]
  it("[TV-SCRUB-CURVE-002] a slow short move is a few seconds, one fast full swipe is tens of minutes, a few reach an hour", () => {
    const slow = feed("CURVE-002-slow", IDLE_SCRUB, swipe(150, 300, 0).pans);
    const fast = feed("CURVE-002-fast", IDLE_SCRUB, swipe(1500, 6000, 0).pans);
    const slowMoved = (slow.state.target ?? 0) - ENV.position;
    const fastMoved = (fast.state.target ?? 0) - ENV.position;
    log("CURVE-002", "moved", { slowMoved, fastMoved });
    expect(slowMoved).toBeGreaterThan(2);
    expect(slowMoved).toBeLessThan(20);
    expect(fastMoved).toBeGreaterThan(10 * 60);
    expect(fastMoved).toBeLessThan(40 * 60);
    // Three fast swipes from the start of the film reach the hour.
    let state = IDLE_SCRUB;
    let at = 0;
    for (let i = 0; i < 3; i += 1) {
      const s = swipe(1500, 6000, at);
      state = feed(`CURVE-002-three-${i}`, state, s.pans.map((p) => ({ ...p, env: { ...p.env, position: 0 } }))).state;
      at = s.endAt + 200;
    }
    log("CURVE-002", "three", { target: state.target });
    expect(state.target).toBeGreaterThanOrEqual(3600);
  });

  // @req UX-TV-01[badger-tv]
  it("[TV-SCRUB-CURVE-003] the target never leaves the film: clamped to 0 and to the duration", () => {
    const back = feed("CURVE-003-back", IDLE_SCRUB, swipe(-1500, 20000, 0).pans);
    const ahead = feed("CURVE-003-ahead", IDLE_SCRUB, swipe(1500, 20000, 0).pans.map((p) => ({ ...p, env: { ...p.env, position: 7000 } })));
    log("CURVE-003", "targets", { back: back.state.target, ahead: ahead.state.target });
    expect(back.state.target).toBe(0);
    expect(ahead.state.target).toBe(7200);
    // No duration known yet: only the start clamps.
    const open = feed("CURVE-003-open", IDLE_SCRUB, swipe(1500, 6000, 0).pans.map((p) => ({ ...p, env: { ...p.env, duration: 0 } })));
    expect(open.state.target).toBeGreaterThan(ENV.position);
  });
});

describe("TV touch scrub: gestures", () => {
  // @req UX-TV-01[badger-tv]
  it("[TV-SCRUB-GESTURE-001] a horizontal pan begins a scrub from the playing position and moves the pending target", () => {
    const { state, effects } = feed("GESTURE-001", IDLE_SCRUB, [
      { pan: pan("Began", 0) },
      { pan: pan("Changed", SCRUB_START_POINTS / 2, 400), env: { now: 10 } },
      { pan: pan("Changed", SCRUB_START_POINTS + 6, 400), env: { now: 20 } },
      { pan: pan("Changed", SCRUB_START_POINTS + 66, 400), env: { now: 40 } },
    ]);
    const types = effects.map((e) => e.type);
    log("GESTURE-001", "effects", types);
    expect(types[0]).toBe("begin");
    expect(effects[0]).toMatchObject({ type: "begin", origin: 600, resumed: false });
    expect(types.filter((t) => t === "step").length).toBe(2);
    expect(state.target).toBeGreaterThan(600);
    expect(scrubPending(state)).toBe(true);
    // Nothing is committed while the finger is down.
    expect(types).not.toContain("commit");
  });

  // @req UX-TV-01[badger-tv]
  it("[TV-SCRUB-GESTURE-002] a vertical-dominant pan, a tap, or a pan outside the scrub context never scrubs", () => {
    const vertical = feed("GESTURE-002-vertical", IDLE_SCRUB, [
      { pan: pan("Began", 0) },
      { pan: pan("Changed", 20, 300, 80, 2000), env: { now: 30 } },
      { pan: pan("Changed", 300, 3000, 90, 100), env: { now: 60 } },
      { pan: pan("Ended", 300, 3000, 90, 100), env: { now: 70 } },
    ]);
    const tap = feed("GESTURE-002-tap", IDLE_SCRUB, [
      { pan: pan("Began", 0) },
      { pan: pan("Changed", 3, 50, 2, 50), env: { now: 30 } },
      { pan: pan("Ended", 3, 50, 2, 50), env: { now: 60 } },
    ]);
    const elsewhere = feed("GESTURE-002-context", IDLE_SCRUB, swipe(800, 3000, 0).pans.map((p) => ({ ...p, env: { ...p.env, canScrub: false } })));
    log("GESTURE-002", "results", { vertical: vertical.state, tap: tap.state, elsewhere: elsewhere.state });
    for (const result of [vertical, tap, elsewhere]) {
      expect(result.state.target).toBeNull();
      expect(scrubPending(result.state)).toBe(false);
      expect(result.effects.some((e) => e.type === "begin" || e.type === "step" || e.type === "commit")).toBe(false);
    }
    expect(vertical.effects).toContainEqual(expect.objectContaining({ type: "ignored", reason: "vertical" }));
    expect(elsewhere.effects).toContainEqual(expect.objectContaining({ type: "ignored", reason: "context" }));
  });

  // @req UX-TV-01[badger-tv]
  it("[TV-SCRUB-GESTURE-003] swipes inside the window keep adding to the same target; the commit comes once, after the window", () => {
    const first = swipe(600, 4000, 0);
    const a = feed("GESTURE-003-first", IDLE_SCRUB, first.pans);
    const afterFirst = a.state.target!;
    // The window has not closed: no commit yet.
    const early = scrubTick(a.state, first.endAt + SCRUB_COMMIT_WINDOW_MS - 1);
    log("GESTURE-003", "early-tick", early);
    expect(early.effects).toEqual([]);
    // The owner's timer is due exactly when the window closes; nothing pending, no timer.
    expect(scrubTickDelay(a.state, first.endAt + 200)).toBe(SCRUB_COMMIT_WINDOW_MS - 200);
    expect(scrubTickDelay(IDLE_SCRUB, 0)).toBeNull();
    // The second swipe starts inside the window, while the film has played on 0.5 s: it adds to the target.
    const second = swipe(600, 4000, first.endAt + SCRUB_COMMIT_WINDOW_MS - 100);
    const b = feed("GESTURE-003-second", early.state, second.pans.map((p) => ({ ...p, env: { ...p.env, position: 600.5 } })));
    log("GESTURE-003", "targets", { afterFirst, afterSecond: b.state.target, gestures: b.state.gestures });
    expect(b.effects[0]).toMatchObject({ type: "begin", resumed: true });
    expect(b.state.target! - afterFirst).toBeCloseTo(afterFirst - 600, 0);
    expect(b.effects.some((e) => e.type === "commit")).toBe(false);
    // The window closes after the last gesture: one commit to the accumulated target, back to idle.
    const due = scrubTick(b.state, second.endAt + SCRUB_COMMIT_WINDOW_MS);
    log("GESTURE-003", "due-tick", due);
    expect(due.effects).toEqual([{ type: "commit", target: b.state.target, origin: 600 }]);
    expect(due.state).toEqual(IDLE_SCRUB);
  });

  // @req UX-TV-01[badger-tv]
  it("[TV-SCRUB-GESTURE-004] a swipe after the window closed (its timer late) commits the old target and starts fresh", () => {
    const first = swipe(600, 4000, 0);
    const a = feed("GESTURE-004-first", IDLE_SCRUB, first.pans);
    const late = feed("GESTURE-004-late", a.state, [{ pan: pan("Began", 0), env: { now: first.endAt + SCRUB_COMMIT_WINDOW_MS + 50, position: a.state.target! } }]);
    log("GESTURE-004", "late", late);
    expect(late.effects).toEqual([{ type: "commit", target: a.state.target, origin: 600 }]);
    expect(late.state.target).toBeNull();
    expect(late.state.gesture).not.toBeNull();
  });

  // @req UX-TV-01[badger-tv]
  it("[TV-SCRUB-GESTURE-005] OK during a pending scrub commits it now; Back cancels it with no seek", () => {
    const a = feed("GESTURE-005", IDLE_SCRUB, swipe(600, 4000, 0).pans);
    const select = scrubSelect(a.state);
    const cancel = scrubCancel(a.state);
    log("GESTURE-005", "select", select);
    log("GESTURE-005", "cancel", cancel);
    expect(select.effects).toEqual([{ type: "commit", target: a.state.target, origin: 600 }]);
    expect(select.state).toEqual(IDLE_SCRUB);
    expect(cancel.effects).toEqual([{ type: "cancel", target: a.state.target, origin: 600 }]);
    expect(cancel.state).toEqual(IDLE_SCRUB);
    expect(cancel.effects.some((e) => e.type === "commit")).toBe(false);
    // With nothing pending, OK and Back are not the scrub's.
    expect(scrubSelect(IDLE_SCRUB).effects).toEqual([]);
    expect(scrubCancel(IDLE_SCRUB).effects).toEqual([]);
  });

  // @req UX-TV-01[badger-tv]
  it("[TV-SCRUB-GESTURE-006] a scrub that comes back to where it started is dropped, not seeked", () => {
    const there = feed("GESTURE-006-there", IDLE_SCRUB, swipe(300, 300, 0).pans);
    const back = feed("GESTURE-006-back", there.state, swipe(-300, 300, 1100).pans);
    log("GESTURE-006", "target", { there: there.state.target, back: back.state.target });
    expect(Math.abs(back.state.target! - 600)).toBeLessThan(0.5);
    const due = scrubTick(back.state, 1000000);
    log("GESTURE-006", "due", due);
    expect(due.effects).toEqual([{ type: "drop", target: back.state.target, origin: 600 }]);
  });

  // @req UX-TV-01[badger-tv]
  it("[TV-SCRUB-GESTURE-007] a gesture whose end never comes is closed after a while and its scrub committed", () => {
    const pans = swipe(600, 4000, 0).pans.slice(0, -1); // no Ended
    const a = feed("GESTURE-007", IDLE_SCRUB, pans);
    const lastAt = a.state.gesture!.at;
    expect(scrubTick(a.state, lastAt + SCRUB_GESTURE_STALE_MS - 1).effects).toEqual([]);
    const stale = scrubTick(a.state, lastAt + SCRUB_GESTURE_STALE_MS);
    log("GESTURE-007", "stale", stale);
    expect(stale.effects).toEqual([{ type: "commit", target: a.state.target, origin: 600 }]);
    // A move arriving without its Began (lost event) starts a gesture from where the finger is, without jumping.
    const orphan = feed("GESTURE-007-orphan", IDLE_SCRUB, [{ pan: pan("Changed", 500, 3000) }]);
    expect(orphan.state.target).toBeNull();
    expect(orphan.state.gesture).toMatchObject({ startX: 500, axis: "undecided" });
  });
});

describe("TV touch scrub: events", () => {
  // @req UX-TV-01[badger-tv]
  it("[TV-SCRUB-EVENT-001] only tvOS pan events are pans; Android TV key events and swipes are not", () => {
    const tvos = panFromEvent({ eventType: "pan", body: { state: "Changed", x: 12, y: -3, velocityX: 812.5, velocityY: -40 } });
    log("EVENT-001", "tvos", tvos);
    expect(tvos).toEqual({ state: "Changed", x: 12, y: -3, velocityX: 812.5, velocityY: -40 });
    const others = [
      { eventType: "left", eventKeyAction: 1 },
      { eventType: "right", eventKeyAction: 0 },
      { eventType: "swipeLeft", body: { state: "Ended" } },
      { eventType: "longRight", eventKeyAction: 0 },
      { eventType: "pan" },
      { eventType: "pan", body: { state: "Changed", x: "a", y: 0 } },
      null,
      undefined,
    ];
    const pans = others.map((event) => panFromEvent(event as never));
    log("EVENT-001", "others", pans);
    expect(pans.every((p) => p === null)).toBe(true);
    // Velocities missing: read as 0 (the base rate), not as noise.
    expect(panFromEvent({ eventType: "pan", body: { state: "Began", x: 0, y: 0 } })).toEqual({ state: "Began", x: 0, y: 0, velocityX: 0, velocityY: 0 });
  });
});
