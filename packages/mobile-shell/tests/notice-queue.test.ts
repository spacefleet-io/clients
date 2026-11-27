/**
 * @test-id MOBILE-SHELL-NOTICE-QUEUE-001
 * @level unit
 * @req UX-NOTICE-01[badger-mobile,badger-tv]
 * @why Chris 2026-11-12 (chat): an in-app notice never moves the page; it floats over it and goes away after a fixed time
 *   or as soon as the user acts on it. The queue is the timing half shared by the phone and TV shells: one notice at a
 *   time, gone after `NOTICE_DURATION_MS`, held while paused (TV focus), and `onDismiss` once per notice with the reason,
 *   which is where the shells mark the device seen. Fake timers, no real waiting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNoticeQueue, NOTICE_DURATION_MS, type NoticeDismissReason } from "../src/notice-queue";

type Item = { id: string };
const trail: string[] = [];
const log = (event: string, payload: Record<string, unknown>) => {
  trail.push(`${event} ${JSON.stringify(payload)}`);
  console.info(`[MOBILE-SHELL-NOTICE-QUEUE-001] ${event}`, JSON.stringify(payload));
};

const setup = () => {
  const dismissed: { id: string; reason: NoticeDismissReason }[] = [];
  const queue = createNoticeQueue<Item>({
    keyOf: (item) => item.id,
    onDismiss: (item, reason) => dismissed.push({ id: item.id, reason }),
    log,
  });
  let renders = 0;
  queue.subscribe(() => renders++);
  return { queue, dismissed, renders: () => renders };
};

describe("notice queue (UX-NOTICE-01)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    trail.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a notice at once and takes it away after the fixed time, reporting a timeout", () => {
    const { queue, dismissed, renders } = setup();
    queue.show({ id: "a" });
    expect(queue.current()).toEqual({ id: "a" });
    vi.advanceTimersByTime(NOTICE_DURATION_MS - 1);
    expect(queue.current()).toEqual({ id: "a" });
    vi.advanceTimersByTime(1);
    console.info("[MOBILE-SHELL-NOTICE-QUEUE-001] trail", JSON.stringify(trail));
    expect(queue.current()).toBeNull();
    expect(dismissed).toEqual([{ id: "a", reason: "timeout" }]);
    expect(renders()).toBe(2);
  });

  it("dismisses at once when the user acts on it, and never twice", () => {
    const { queue, dismissed } = setup();
    queue.show({ id: "a" });
    queue.dismiss("opened");
    queue.dismiss("closed");
    vi.advanceTimersByTime(NOTICE_DURATION_MS * 2);
    expect(queue.current()).toBeNull();
    expect(dismissed).toEqual([{ id: "a", reason: "opened" }]);
  });

  it("shows queued notices one after the other and drops a repeat of one already waiting or shown", () => {
    const { queue, dismissed } = setup();
    queue.show({ id: "a" });
    queue.show({ id: "b" });
    queue.show({ id: "a" });
    queue.show({ id: "b" });
    expect(queue.current()).toEqual({ id: "a" });
    queue.dismiss("closed");
    expect(queue.current()).toEqual({ id: "b" });
    vi.advanceTimersByTime(NOTICE_DURATION_MS);
    expect(queue.current()).toBeNull();
    console.info("[MOBILE-SHELL-NOTICE-QUEUE-001] trail", JSON.stringify(trail));
    expect(dismissed).toEqual([
      { id: "a", reason: "closed" },
      { id: "b", reason: "timeout" },
    ]);
  });

  // UX-NOTICE-02: the offline notice is taken back when the connection returns, whether it is showing or still waiting.
  it("withdraws a notice whose subject ended: the shown one leaves at once, a waiting one never shows", () => {
    const { queue, dismissed } = setup();
    queue.show({ id: "offline" });
    queue.show({ id: "b" });
    queue.withdraw("offline");
    expect(queue.current()).toEqual({ id: "b" });
    queue.show({ id: "offline" });
    queue.withdraw("offline");
    queue.withdraw("never-shown");
    vi.advanceTimersByTime(NOTICE_DURATION_MS);
    console.info("[MOBILE-SHELL-NOTICE-QUEUE-001] withdraw trail", JSON.stringify(trail));
    expect(queue.current()).toBeNull();
    expect(dismissed).toEqual([
      { id: "offline", reason: "withdrawn" },
      { id: "b", reason: "timeout" },
    ]);
  });

  it("holds the timer while paused (the TV notice has focus) and gives a full period again on resume", () => {
    const { queue, dismissed } = setup();
    queue.show({ id: "a" });
    vi.advanceTimersByTime(NOTICE_DURATION_MS - 1_000);
    queue.setPaused(true);
    vi.advanceTimersByTime(NOTICE_DURATION_MS * 5);
    expect(queue.current()).toEqual({ id: "a" });
    queue.setPaused(false);
    vi.advanceTimersByTime(NOTICE_DURATION_MS - 1);
    expect(queue.current()).toEqual({ id: "a" });
    vi.advanceTimersByTime(1);
    expect(dismissed).toEqual([{ id: "a", reason: "timeout" }]);
  });

  it("Back dismisses with its own reason, and dispose stops the timer", () => {
    const { queue, dismissed } = setup();
    queue.show({ id: "a" });
    queue.dismiss("back");
    queue.show({ id: "b" });
    queue.dispose();
    vi.advanceTimersByTime(NOTICE_DURATION_MS * 2);
    expect(dismissed).toEqual([{ id: "a", reason: "back" }]);
  });

  /**
   * @bugfix @regression-proof
   * Closed test 2026-11-13: a "New device added" notice raised while the player covered the shell showed behind it,
   * timed out there and was marked seen, so the user never saw it. While held (a screen covers the shell) nothing shows
   * and no timer runs; it shows, with a full period, once the shell is visible again.
   */
  it("@bugfix @regression-proof keeps a notice waiting while held (the player covers the shell) and shows it once released", () => {
    const { queue, dismissed } = setup();
    queue.setHeld(true);
    queue.show({ id: "a" });
    vi.advanceTimersByTime(NOTICE_DURATION_MS * 5);
    console.info("[MOBILE-SHELL-NOTICE-QUEUE-001] held", JSON.stringify({ current: queue.current(), dismissed, trail }));
    expect(queue.current()).toBeNull();
    expect(dismissed).toEqual([]);

    queue.setHeld(false);
    expect(queue.current()).toEqual({ id: "a" });
    vi.advanceTimersByTime(NOTICE_DURATION_MS - 1);
    expect(queue.current()).toEqual({ id: "a" });
    vi.advanceTimersByTime(1);
    expect(dismissed).toEqual([{ id: "a", reason: "timeout" }]);
  });

  it("@bugfix @regression-proof takes a showing notice back into the queue when the player opens over it, unseen", () => {
    const { queue, dismissed } = setup();
    queue.show({ id: "a" });
    queue.show({ id: "b" });
    vi.advanceTimersByTime(NOTICE_DURATION_MS - 1_000);
    queue.setHeld(true);
    vi.advanceTimersByTime(NOTICE_DURATION_MS * 5);
    console.info("[MOBILE-SHELL-NOTICE-QUEUE-001] held over shown", JSON.stringify({ current: queue.current(), dismissed, trail }));
    expect(queue.current()).toBeNull();
    expect(dismissed).toEqual([]);

    queue.setHeld(false);
    expect(queue.current()).toEqual({ id: "a" });
    vi.advanceTimersByTime(NOTICE_DURATION_MS);
    expect(queue.current()).toEqual({ id: "b" });
    expect(dismissed).toEqual([{ id: "a", reason: "timeout" }]);
  });
});
