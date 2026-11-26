// @vitest-environment jsdom
/**
 * @test-id ui-notice-toast
 * @level component
 * @req UX-NOTICE-03[badger-desktop,parrot] @req UX-NOTICE-11[badger-desktop,parrot,parrot-web-player]
 * @why Every computer notice goes through this sonner wrapper: it alone decides how long a toast stays (4 s for "it
 * worked", 8 s for a heads-up, 8 s idle for one with a button), keeps one on screen while the pointer or focus is on
 * it, and makes a repeat with the same id replace the toast instead of stacking. A regression shows on every screen.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notifications, toast, toastDuration } from "../src/notifications";

const LOG = "[ui-notice-toast]";
let host: HTMLDivElement;
let root: Root;

const toasts = () => [...document.querySelectorAll<HTMLElement>("[data-sonner-toast]")];
const shown = () => toasts().map((el) => ({ id: el.getAttribute("data-testid"), text: el.textContent }));
const elapse = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("notice toasts", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(<Notifications />));
  });
  afterEach(async () => {
    await act(async () => toast.dismiss());
    await elapse(1_000);
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it("@req UX-NOTICE-03 the time on screen comes from the kind, never from the caller", () => {
    const times = {
      confirmation: toastDuration("success", {}),
      headsUp: toastDuration("default", {}),
      warning: toastDuration("warning", {}),
      withButton: toastDuration("success", { action: { label: "Open", onClick: () => {} } }),
      jobDone: toastDuration("default", { kind: "job", outcome: "done" }),
      jobFailed: toastDuration("error", { kind: "job", outcome: "failed" }),
    };
    console.info(`${LOG} phase=timings ${JSON.stringify(times)}`);
    expect(times).toEqual({ confirmation: 4_000, headsUp: 8_000, warning: 8_000, withButton: 8_000, jobDone: 4_000, jobFailed: 8_000 });
  });

  it("@req UX-NOTICE-03 a confirmation leaves after 4 s and a heads-up after 8 s", async () => {
    await act(async () => {
      toast.success("Saved", { id: "saved" });
      toast.warning("Heads up", { id: "heads" });
    });
    await elapse(100);
    console.info(`${LOG} phase=shown ${JSON.stringify(shown())}`);
    expect(shown().map((t) => t.id).sort()).toEqual(["sf-notice-heads", "sf-notice-saved"]);
    await elapse(4_500);
    console.info(`${LOG} phase=after-4.6s ${JSON.stringify(shown())}`);
    expect(shown().map((t) => t.id)).toEqual(["sf-notice-heads"]);
    await elapse(4_000);
    console.info(`${LOG} phase=after-8.6s ${JSON.stringify(shown())}`);
    expect(shown()).toEqual([]);
  });

  it("@req UX-NOTICE-11 the same id replaces the toast in place with a fresh time", async () => {
    await act(async () => void toast.error("Playback failed", { id: "playback-failed" }));
    await elapse(6_000);
    await act(async () => void toast.error("Playback failed again", { id: "playback-failed" }));
    await elapse(100);
    console.info(`${LOG} phase=replaced ${JSON.stringify(shown())}`);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]?.text).toContain("Playback failed again");
    // 6 s after the replace, past the first one's 8 s: still there.
    await elapse(6_000);
    console.info(`${LOG} phase=fresh-timer ${JSON.stringify(shown())}`);
    expect(shown()).toHaveLength(1);
    await elapse(3_000);
    expect(shown()).toEqual([]);
  });

  it("@req UX-NOTICE-03 the pointer on a toast holds it; its full time starts again once the pointer leaves", async () => {
    await act(async () => void toast("Too slow", { id: "too-weak", action: { label: "Keep watching", onClick: () => {} } }));
    await elapse(100);
    const [el] = toasts();
    if (!el) throw new Error("no toast");
    await act(async () => void el.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    await elapse(20_000);
    console.info(`${LOG} phase=held-20s ${JSON.stringify(shown())}`);
    expect(shown()).toHaveLength(1);
    await act(async () => void el.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
    await elapse(7_000);
    console.info(`${LOG} phase=released-7s ${JSON.stringify(shown())}`);
    expect(shown()).toHaveLength(1);
    await elapse(2_000);
    console.info(`${LOG} phase=released-9s ${JSON.stringify(shown())}`);
    expect(shown()).toEqual([]);
  });
});
