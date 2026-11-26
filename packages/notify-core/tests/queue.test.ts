/**
 * @test-id NOTIFY-CORE-QUEUE-001
 * @level unit
 * @req UX-NOTICE-03[badger-desktop,badger-mobile,badger-tv,parrot]
 * @req UX-NOTICE-11[badger-desktop,badger-mobile,badger-tv,parrot,parrot-tv,badger-web-player,parrot-web-player]
 * @req UX-NOTICE-09[badger-tv,parrot-tv]
 * @why Chris 2026-11-26 (chat, notifications draft questions 1, 7 and 9): a confirmation stays 4 seconds, a heads-up 8, a
 *   notice with a button 8 seconds with neither pointer nor focus on it; no notice stays for good except the TV's
 *   one-time message, which waits for OK or Back; a repeat replaces the earlier copy on screen. The shared line of
 *   notices every app draws is where those times and the replace live. Fake timers, no real waiting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoticeQueue, durationFor, NOTICE_TIMINGS, type Notice, type NoticeDismissReason } from "../src/index";

const ID = "NOTIFY-CORE-QUEUE-001";
const trail: string[] = [];
const log = (event: string, payload: Record<string, unknown>) => {
  trail.push(`${event} ${JSON.stringify(payload)}`);
  console.info(`[${ID}] ${event}`, JSON.stringify(payload));
};

const setup = (maxVisible = 1) => {
  const dismissed: { key: string; reason: NoticeDismissReason }[] = [];
  const queue = createNoticeQueue<Notice>({
    keyOf: (notice) => notice.key,
    durationOf: durationFor,
    maxVisible,
    onDismiss: (notice, reason) => dismissed.push({ key: notice.key, reason }),
    log,
  });
  let changes = 0;
  queue.subscribe(() => changes++);
  const keys = () => queue.visible().map((notice) => notice.key);
  return { queue, dismissed, keys, changes: () => changes };
};

const confirmation = (key: string): Notice => ({ key, kind: "confirmation", level: "success", message: key });
const headsUp = (key: string, message = key): Notice => ({ key, kind: "headsUp", level: "warning", message });

describe("notice line (UX-NOTICE-03, UX-NOTICE-09, UX-NOTICE-11)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    trail.length = 0;
  });
  afterEach(() => {
    console.info(`[${ID}] trail`, JSON.stringify(trail));
    vi.useRealTimers();
  });

  it("gives each kind its time: confirmation 4 s, heads-up 8 s, with a button 8 s, failed job 8 s, finished job 4 s", () => {
    console.info(`[${ID}] phase timings`, JSON.stringify(NOTICE_TIMINGS));
    expect(durationFor({ kind: "confirmation" })).toBe(4_000);
    expect(durationFor({ kind: "headsUp" })).toBe(8_000);
    expect(durationFor({ kind: "lasting" })).toBe(8_000);
    expect(durationFor({ kind: "confirmation", action: { label: "Undo", target: "undo" } })).toBe(8_000);
    expect(durationFor({ kind: "job", outcome: "failed" })).toBe(8_000);
    expect(durationFor({ kind: "job", outcome: "done" })).toBe(4_000);
    expect(durationFor({ kind: "headsUp", oneTime: true })).toBeNull();
    expect(durationFor({ kind: "decision" })).toBeNull();

    const { queue, dismissed } = setup(3);
    queue.show(confirmation("saved"));
    queue.show(headsUp("device"));
    vi.advanceTimersByTime(3_999);
    expect(dismissed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(dismissed).toEqual([{ key: "saved", reason: "timeout" }]);
    vi.advanceTimersByTime(4_000);
    expect(dismissed).toEqual([
      { key: "saved", reason: "timeout" },
      { key: "device", reason: "timeout" },
    ]);
  });

  it("stops a notice's time while the pointer or focus is on it and gives a full period again after", () => {
    const { queue, dismissed } = setup(3);
    queue.show({ ...headsUp("slow"), action: { label: "Keep watching", target: "keep" } });
    queue.show(confirmation("saved"));
    vi.advanceTimersByTime(7_000);
    console.info(`[${ID}] phase pointer on "slow"`);
    queue.setPaused(true, "slow");
    vi.advanceTimersByTime(60_000);
    expect(dismissed).toEqual([{ key: "saved", reason: "timeout" }]);
    console.info(`[${ID}] phase pointer leaves`);
    queue.setPaused(false, "slow");
    vi.advanceTimersByTime(7_999);
    expect(dismissed).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(dismissed[1]).toEqual({ key: "slow", reason: "timeout" });
  });

  it("pauses every visible notice when no key is given (pointer on the whole stack)", () => {
    const { queue, dismissed } = setup(3);
    queue.show(confirmation("a"));
    queue.show(confirmation("b"));
    queue.setPaused(true);
    vi.advanceTimersByTime(30_000);
    expect(dismissed).toEqual([]);
    queue.setPaused(false);
    vi.advanceTimersByTime(4_000);
    expect(dismissed.map((d) => d.key)).toEqual(["a", "b"]);
  });

  it("never keeps a warning with a button for good: it leaves after 8 s idle (UX-NOTICE-11)", () => {
    const { queue, dismissed } = setup();
    queue.show({ key: "too-slow", kind: "headsUp", level: "warning", action: { label: "Keep watching", target: "keep" } });
    vi.advanceTimersByTime(8_000);
    expect(queue.current()).toBeNull();
    expect(dismissed).toEqual([{ key: "too-slow", reason: "timeout" }]);
  });

  it("replaces a repeat where it stands, with a fresh time, instead of stacking it", () => {
    const { queue, keys, dismissed } = setup(3);
    queue.show(headsUp("play-failed:42:codec", "first"));
    queue.show(confirmation("saved"));
    vi.advanceTimersByTime(6_000);
    console.info(`[${ID}] phase same failure again`);
    queue.show(headsUp("play-failed:42:codec", "second"));
    expect(keys()).toEqual(["play-failed:42:codec"]);
    expect(queue.current()?.message).toBe("second");
    vi.advanceTimersByTime(7_999);
    expect(queue.current()?.key).toBe("play-failed:42:codec");
    vi.advanceTimersByTime(1);
    expect(dismissed.filter((d) => d.key === "play-failed:42:codec")).toEqual([{ key: "play-failed:42:codec", reason: "timeout" }]);
  });

  it("replaces a waiting repeat in its place in the line, unseen", () => {
    const { queue, keys } = setup(1);
    queue.show(headsUp("a"));
    queue.show(headsUp("b", "old"));
    queue.show(headsUp("c"));
    queue.show(headsUp("b", "new"));
    queue.dismiss("closed");
    expect(keys()).toEqual(["b"]);
    expect(queue.current()?.message).toBe("new");
  });

  it("stacks up to its maximum and shows the next one when a place frees up", () => {
    const { queue, keys } = setup(3);
    for (const key of ["a", "b", "c", "d"]) queue.show(headsUp(key));
    expect(keys()).toEqual(["a", "b", "c"]);
    queue.dismiss("closed", "b");
    expect(keys()).toEqual(["a", "c", "d"]);
    queue.dismiss("opened");
    expect(keys()).toEqual(["c", "d"]);
  });

  it("keeps the same snapshot until the line changes", () => {
    const { queue } = setup(3);
    queue.show(headsUp("a"));
    const first = queue.visible();
    queue.setPaused(true);
    expect(queue.visible()).toBe(first);
    queue.show(headsUp("b"));
    expect(queue.visible()).not.toBe(first);
  });

  it("takes a notice back, showing or waiting", () => {
    const { queue, dismissed, keys } = setup(1);
    queue.show(headsUp("offline"));
    queue.show(headsUp("later"));
    queue.withdraw("later");
    queue.withdraw("offline");
    expect(keys()).toEqual([]);
    expect(dismissed).toEqual([{ key: "offline", reason: "withdrawn" }]);
  });

  it("puts visible notices back in front of the line while held and shows them again with a full period", () => {
    const { queue, keys, dismissed } = setup(3);
    queue.show(headsUp("a"));
    queue.show(headsUp("b"));
    queue.setPaused(true, "a");
    vi.advanceTimersByTime(5_000);
    console.info(`[${ID}] phase player covers the app`);
    queue.setHeld(true);
    queue.show(headsUp("c"));
    expect(keys()).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(dismissed).toEqual([]);
    queue.setHeld(false);
    expect(keys()).toEqual(["a", "b", "c"]);
    vi.advanceTimersByTime(8_000);
    expect(dismissed.map((d) => d.key)).toEqual(["a", "b", "c"]);
  });

  it("keeps the TV's one-time message until OK or Back, never on a timer (UX-NOTICE-09)", () => {
    const { queue, dismissed } = setup(1);
    queue.show({ key: "founder", kind: "headsUp", level: "info", oneTime: true });
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(queue.current()?.key).toBe("founder");
    queue.dismiss("back");
    expect(dismissed).toEqual([{ key: "founder", reason: "back" }]);
  });
});
