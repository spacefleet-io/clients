// @vitest-environment jsdom
/**
 * The first-open tour shared by Badger and Parrot (UX-TOUR-01..04, PAR-TOUR-01..04). Chris 2026-11-12 (chat): "step
 * one should be a modal telling the user to drag and drop their first video file (with a small video looping to show
 * visually what they should do)"; "step 1 shouldn't have a "next" button that shows step 2 without the user having
 * drag and dropped anything. They either do the drag and drop (which shows step 2) or skip the tour"; "If we do it
 * before it opens then we risk the user taking too much time and the import job having already finished".
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_TOUR_STORAGE_KEYS,
  DesktopTourHost,
  desktopTourStrings,
  desktopTourText,
  isDesktopTourStepSeen,
  markDesktopTourStepSeen,
  placeTourCard,
  startDesktopTour,
  takeDesktopTourRequest,
} from "../src/tour";
import { WINDOW_DROP_PASSES } from "../src/window-drop";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom lays nothing out: give an element a box so the tour can find and light it. */
const placed = <T extends HTMLElement>(element: T, rect = { top: 12, left: 900, width: 36, height: 36 }): T => {
  element.getBoundingClientRect = () =>
    ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON: () => rect }) as DOMRect;
  document.body.appendChild(element);
  return element;
};

/** The app's jobs button (`data-tour="jobs"`) with how many jobs its panel lists. */
const jobsButton = (count: number): HTMLButtonElement => {
  const button = document.createElement("button");
  button.setAttribute("data-tour", "jobs");
  button.setAttribute("data-tour-jobs-count", String(count));
  return placed(button);
};

/** A dialog of the app, as Radix renders it, marked for the tour or not. */
const dialog = (attributes: Record<string, string>): HTMLDivElement => {
  const element = document.createElement("div");
  element.setAttribute("role", "dialog");
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return placed(element, { top: 100, left: 100, width: 600, height: 400 });
};

const q = (testId: string): HTMLElement | null => document.querySelector(`[data-testid="${testId}"]`);
const click = (testId: string) => act(() => q(testId)!.click());
/** Lets the tour see a DOM change (its observer reads the page on the next frame). */
const settle = (ms = 50) =>
  act(async () => {
    await Promise.resolve();
    vi.advanceTimersByTime(ms);
  });

describe("desktop first-open tour", () => {
  let host: HTMLDivElement;
  let root: Root;
  let pickResult: boolean;
  let picks: number;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    takeDesktopTourRequest();
    window.requestAnimationFrame = (callback) => window.setTimeout(() => callback(performance.now()), 16);
    window.cancelAnimationFrame = (frame) => window.clearTimeout(frame);
    pickResult = true;
    picks = 0;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  const tour = (props: Partial<React.ComponentProps<typeof DesktopTourHost>> = {}) => (
    <DesktopTourHost
      app="badger"
      language="en"
      ready
      videoSrc="tour-drop.webm"
      onPickFiles={async () => {
        picks += 1;
        return pickResult;
      }}
      {...props}
    />
  );
  const mount = async (props: Partial<React.ComponentProps<typeof DesktopTourHost>> = {}) => {
    act(() => root.render(tour(props)));
    await settle(600);
  };

  it("opens step 1 as a drop modal with a looping video, Step 1 of 3 and no Next @req UX-TOUR-01 @req PAR-TOUR-01", async () => {
    await mount();
    const modal = q("desktop-tour")!;
    expect(modal.getAttribute("data-step")).toBe("intro");
    expect(q("desktop-tour-card")!.getAttribute("role")).toBe("dialog");
    expect(q("desktop-tour-progress")!.textContent).toBe("Step 1 of 3");
    expect(q("desktop-tour-dots")!.children).toHaveLength(3);
    expect(modal.textContent).toContain(desktopTourText("en", "badger.intro.title"));
    const video = q("desktop-tour-video") as HTMLVideoElement;
    expect([video.autoplay, video.loop, video.muted]).toEqual([true, true, true]);
    expect(video.getAttribute("src")).toBe("tour-drop.webm");
    const buttons = Array.from(modal.querySelectorAll("button")).map((button) => button.textContent);
    console.info("[desktop-tour.test] step 1 buttons", buttons);
    expect(buttons).toEqual([desktopTourText("en", "skip"), desktopTourText("en", "pickFiles")]);
    expect(document.activeElement).toBe(q("desktop-tour-pick-files"));
  });

  it("makes step 1 wider than the other cards, its video filling the width at 16:9, bounded to fit the window @req UX-TOUR-01 @req PAR-TOUR-01", async () => {
    await mount();
    const card = q("desktop-tour-card")!;
    const style = card.getAttribute("style") ?? "";
    console.info("[desktop-tour.test] step 1 card style", style);
    expect(style).toContain("576px");
    expect(style).toContain("90vw");
    expect(style).toContain("100vh");
    const video = q("desktop-tour-video")!;
    expect(video.className).toContain("aspect-video");
    expect(video.className).toContain("w-full");
  });

  it("lets a drop through to the window, hides while files are dragged over, and ends when the import shows @req UX-TOUR-01 @req PAR-TOUR-01", async () => {
    await mount();
    const modal = q("desktop-tour")!;
    expect(modal.getAttribute("data-window-drop")).toBe(WINDOW_DROP_PASSES["data-window-drop"]);
    expect(modal.matches('[role="dialog"]:not([data-window-drop="pass"])')).toBe(false);
    expect(q("desktop-tour-card")!.matches('[role="dialog"]:not([data-window-drop="pass"])')).toBe(false);

    const drag = (type: string) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"] } });
      act(() => void window.dispatchEvent(event));
    };
    drag("dragenter");
    expect(modal.getAttribute("data-hidden")).toBe("true");
    drag("dragleave");
    expect(modal.getAttribute("data-hidden")).toBe("false");
    drag("dragenter");
    drag("drop");
    expect(modal.getAttribute("data-hidden")).toBe("true");
    // The app refused the drop (nothing opened): the modal comes back.
    await settle(8_100);
    expect(q("desktop-tour")!.getAttribute("data-hidden")).toBe("false");
    expect(isDesktopTourStepSeen("intro")).toBe(false);

    act(() => void window.dispatchEvent(new Event("sf:native-file-drop")));
    expect(q("desktop-tour")!.getAttribute("data-hidden")).toBe("true");
    dialog({ "data-tour": "import-review" });
    await settle();
    expect(isDesktopTourStepSeen("intro")).toBe(true);
    expect(q("desktop-tour")).toBeNull();
  });

  it("or pick files opens the app's picker: a choice ends step 1, a cancel keeps it @req UX-TOUR-01 @req PAR-TOUR-01", async () => {
    await mount({ app: "parrot" });
    expect(q("desktop-tour")!.textContent).toContain(desktopTourText("en", "parrot.intro.title"));
    pickResult = false;
    await act(async () => q("desktop-tour-pick-files")!.click());
    expect(picks).toBe(1);
    expect(q("desktop-tour")).not.toBeNull();
    pickResult = true;
    await act(async () => q("desktop-tour-pick-files")!.click());
    expect(picks).toBe(2);
    expect(q("desktop-tour")).toBeNull();
    expect(isDesktopTourStepSeen("intro")).toBe(true);
    expect(isDesktopTourStepSeen("review")).toBe(false);
  });

  it("Skip tour and Escape end the whole tour on any step @req UX-TOUR-01 @req UX-TOUR-02 @req PAR-TOUR-02", async () => {
    await mount();
    act(() => void q("desktop-tour")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(q("desktop-tour")).toBeNull();
    expect(["intro", "review", "jobs"].map((step) => isDesktopTourStepSeen(step as "intro"))).toEqual([true, true, true]);

    // Nothing comes back on the next import.
    dialog({ "data-tour": "import-review" });
    jobsButton(1);
    await settle();
    expect(q("desktop-tour-card")).toBeNull();

    localStorage.clear();
    act(() => root.unmount());
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await mount();
    click("desktop-tour-skip");
    expect(q("desktop-tour")).toBeNull();
    expect(isDesktopTourStepSeen("jobs")).toBe(true);
  });

  it("shows step 2 inside the import review once it lists what it found, once @req UX-TOUR-01 @req PAR-TOUR-01", async () => {
    markDesktopTourStepSeen("intro");
    await mount();
    expect(q("desktop-tour")).toBeNull();
    const review = dialog({ "data-tour": "import-review" });
    await settle();
    const card = q("desktop-tour-card")!;
    expect(review.contains(card)).toBe(true);
    expect(card.getAttribute("data-step")).toBe("review");
    expect(q("desktop-tour-progress")!.textContent).toBe("Step 2 of 3");
    expect(card.textContent).toContain(desktopTourText("en", "badger.review.title"));
    click("desktop-tour-got-it");
    expect(q("desktop-tour-card")).toBeNull();
    review.remove();
    await settle();
    dialog({ "data-tour": "import-review" });
    await settle();
    expect(q("desktop-tour-card")).toBeNull();
  });

  it("shows step 3 in the jobs panel when it opens, with the button that reopens it lit @req UX-TOUR-01 @req PAR-TOUR-01", async () => {
    markDesktopTourStepSeen("intro");
    markDesktopTourStepSeen("review");
    jobsButton(0);
    await mount();
    expect(q("desktop-tour-card")).toBeNull();
    const panel = dialog({ "data-tour": "jobs-panel", "data-state": "open" });
    await settle();
    const card = q("desktop-tour-card")!;
    expect(panel.contains(card)).toBe(true);
    expect(q("desktop-tour-progress")!.textContent).toBe("Step 3 of 3");
    expect(card.textContent).toContain(desktopTourText("en", "badger.jobsPanel.body"));
    expect(q("desktop-tour-spotlight")).not.toBeNull();
    click("desktop-tour-got-it");
    expect(q("desktop-tour-card")).toBeNull();
    expect(isDesktopTourStepSeen("jobs")).toBe(true);
  });

  it("shows step 3 on the jobs button when the first job appears with the panel closed, even if it already finished @req UX-TOUR-01 @req PAR-TOUR-01", async () => {
    markDesktopTourStepSeen("intro");
    markDesktopTourStepSeen("review");
    const button = jobsButton(0);
    await mount({ app: "parrot" });
    expect(q("desktop-tour")).toBeNull();
    // Waits while another dialog of the app (the review) is still open.
    const review = dialog({});
    act(() => button.setAttribute("data-tour-jobs-count", "1"));
    await settle();
    expect(q("desktop-tour")).toBeNull();
    review.remove();
    await settle();
    const step = q("desktop-tour")!;
    expect(step.getAttribute("data-variant")).toBe("button");
    expect(step.textContent).toContain(desktopTourText("en", "parrot.jobs.body"));
    expect(desktopTourText("en", "parrot.jobs.body")).not.toMatch(/watch/i);
    expect(q("desktop-tour-spotlight")).not.toBeNull();
    // Opening the panel moves the card into it.
    dialog({ "data-tour": "jobs-panel", "data-state": "open" });
    await settle();
    expect(q("desktop-tour")).toBeNull();
    expect(q("desktop-tour-card")!.closest('[data-tour="jobs-panel"]')).not.toBeNull();
  });

  it("an import started before Home (Parrot's setup scan) gives step 2 then step 3, never step 1, and step 3 waits for step 2 @req UX-TOUR-01 @req PAR-TOUR-01 @req PAR-TOUR-02 @bugfix @regression-proof", async () => {
    const log = (phase: string) =>
      console.info(`[desktop-tour.test:setup-import] ${phase}`, {
        card: q("desktop-tour-card")?.getAttribute("data-step") ?? null,
        tour: q("desktop-tour")?.getAttribute("data-step") ?? q("desktop-tour")?.getAttribute("data-variant") ?? null,
        seen: (["intro", "review", "jobs"] as const).map((step) => `${step}=${isDesktopTourStepSeen(step)}`).join(" "),
      });
    const button = jobsButton(0);
    act(() => root.render(tour({ app: "parrot", ready: false })));
    await settle();
    // The setup's folder scan lists a job before its review opens.
    act(() => button.setAttribute("data-tour-jobs-count", "1"));
    await settle();
    log("job listed, no review yet");
    expect(q("desktop-tour")).toBeNull();
    expect(q("desktop-tour-card")).toBeNull();
    expect(isDesktopTourStepSeen("jobs")).toBe(false);

    // Home shows with the review already open: step 2 in it, and step 1 never opens (not even after its delay).
    const review = dialog({ "data-tour": "import-review" });
    act(() => root.render(tour({ app: "parrot" })));
    await settle(1_000);
    log("review open on Home");
    const card = q("desktop-tour-card")!;
    expect(card.getAttribute("data-step")).toBe("review");
    expect(review.contains(card)).toBe(true);
    expect(document.querySelector('[data-step="intro"]')).toBeNull();
    expect(isDesktopTourStepSeen("intro")).toBe(true);
    expect(isDesktopTourStepSeen("jobs")).toBe(false);

    click("desktop-tour-got-it");
    review.remove();
    await settle();
    log("review closed");
    const step = q("desktop-tour")!;
    expect(step.getAttribute("data-variant")).toBe("button");
    expect(step.textContent).toContain(desktopTourText("en", "parrot.jobs.body"));
    expect(isDesktopTourStepSeen("jobs")).toBe(true);
  });

  it("never opens step 1 when the import review is already up as Home shows @req PAR-TOUR-01 @req PAR-TOUR-02 @bugfix", async () => {
    act(() => root.render(tour({ app: "parrot", ready: false })));
    const review = dialog({ "data-tour": "import-review" });
    await settle();
    expect(q("desktop-tour-card")!.getAttribute("data-step")).toBe("review");
    const opened: string[] = [];
    const watch = new MutationObserver(() => {
      if (document.querySelector('[data-step="intro"]')) opened.push("intro");
    });
    watch.observe(document.body, { subtree: true, childList: true });
    act(() => root.render(tour({ app: "parrot" })));
    await settle(1_000);
    watch.disconnect();
    console.info("[desktop-tour.test:review-first] intro renders", opened.length);
    expect(opened).toEqual([]);
    expect(review.contains(q("desktop-tour-card"))).toBe(true);
  });

  it("step 3 waits for step 2 when the jobs panel opens first @req UX-TOUR-01 @req PAR-TOUR-01 @bugfix", async () => {
    markDesktopTourStepSeen("intro");
    jobsButton(1);
    await mount();
    const panel = dialog({ "data-tour": "jobs-panel", "data-state": "open" });
    await settle();
    console.info("[desktop-tour.test:panel-first] card", q("desktop-tour-card")?.getAttribute("data-step") ?? null);
    expect(q("desktop-tour-card")).toBeNull();
    expect(isDesktopTourStepSeen("jobs")).toBe(false);
    panel.remove();
    const review = dialog({ "data-tour": "import-review" });
    await settle();
    expect(q("desktop-tour-card")!.getAttribute("data-step")).toBe("review");
    click("desktop-tour-got-it");
    review.remove();
    dialog({ "data-tour": "jobs-panel", "data-state": "open" });
    await settle();
    expect(q("desktop-tour-card")!.getAttribute("data-step")).toBe("jobs");
  });

  it("opens step 1 once per computer, and not on its own under the SF_FIRST_TOUR=off seam @req UX-TOUR-02 @req PAR-TOUR-02", async () => {
    act(() => root.render(tour({ ready: false })));
    await settle(1_000);
    expect(q("desktop-tour")).toBeNull();
    act(() => root.render(tour()));
    await settle(600);
    expect(q("desktop-tour")).not.toBeNull();
    dialog({ "data-tour": "import-review" });
    await settle();
    expect(isDesktopTourStepSeen("intro")).toBe(true);
    act(() => root.unmount());
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await mount();
    expect(q("desktop-tour")).toBeNull();

    localStorage.clear();
    act(() => root.unmount());
    root = createRoot(host);
    await mount({ suppressed: true });
    expect(q("desktop-tour")).toBeNull();
    dialog({ "data-tour": "import-review" });
    jobsButton(1);
    await settle();
    expect(q("desktop-tour-card")).toBeNull();
  });

  it("Show the tour again reopens step 1 now or on the next Home, then steps 2 and 3 on the next import @req UX-TOUR-04 @req PAR-TOUR-04", async () => {
    for (const step of ["intro", "review", "jobs"] as const) markDesktopTourStepSeen(step);
    await mount({ suppressed: true });
    expect(q("desktop-tour")).toBeNull();
    act(() => startDesktopTour());
    await settle(600);
    expect(q("desktop-tour")!.getAttribute("data-step")).toBe("intro");
    click("desktop-tour-skip");
    act(() => root.unmount());

    startDesktopTour();
    root = createRoot(host);
    await mount({ suppressed: true });
    expect(q("desktop-tour")).not.toBeNull();
    const review = dialog({ "data-tour": "import-review" });
    await settle();
    expect(q("desktop-tour-card")!.getAttribute("data-step")).toBe("review");
    click("desktop-tour-got-it");
    review.remove();
    jobsButton(1);
    await settle();
    expect(q("desktop-tour")!.getAttribute("data-step")).toBe("jobs");
  });

  it("replays step 1 when React mounts the host twice (StrictMode) @req UX-TOUR-04 @req PAR-TOUR-04", async () => {
    markDesktopTourStepSeen("intro");
    startDesktopTour();
    act(() =>
      root.render(
        <React.StrictMode>
          {tour()}
        </React.StrictMode>,
      ),
    );
    await settle(1_000);
    expect(q("desktop-tour")).not.toBeNull();
  });

  it("keeps its flags through sign-out @req UX-TOUR-02", async () => {
    expect(DESKTOP_TOUR_STORAGE_KEYS).toEqual([
      "sf_desktop_tour_intro_seen_v2",
      "sf_desktop_tour_review_seen_v2",
      "sf_desktop_tour_jobs_seen_v2",
    ]);
  });

  it("places the jobs-button card below the button and keeps it in the window @req UX-TOUR-01", async () => {
    const card = { width: 360, height: 180 };
    const viewport = { width: 1280, height: 800 };
    expect(placeTourCard({ top: 20, left: 600, width: 100, height: 40 }, card, viewport, "bottom")).toEqual({ top: 74, left: 470, side: "bottom" });
    expect(placeTourCard({ top: 4, left: 1200, width: 52, height: 52 }, card, viewport, "bottom").left).toBe(904);
    expect(placeTourCard(null, card, viewport)).toEqual({ top: 310, left: 460, side: "center" });
  });

  it("has every string in every shipped language, with the region dropped and English as the fallback @req UX-TOUR-01 @req PAR-TOUR-01", async () => {
    const keys = Object.keys(desktopTourStrings.en);
    for (const [language, table] of Object.entries(desktopTourStrings)) {
      const missing = keys.filter((k) => !(table as Record<string, string>)[k]?.trim());
      console.info(`[desktop-tour.test] ${language}: ${keys.length - missing.length}/${keys.length}`);
      expect(missing).toEqual([]);
    }
    expect(desktopTourText("fr-FR", "stepOf", { n: 2, m: 3 })).toBe("Étape 2 sur 3");
    expect(desktopTourText("xx", "skip")).toBe("Skip tour");
  });
});
