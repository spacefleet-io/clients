// @vitest-environment jsdom
//
// @bugfix @regression-proof issue #25 P1 residual — after PR #147 the hidden
// app window still cost 5–6 % renderer CPU during external playback (budget
// renderer_cpu_hidden_pct ≤ 5). CDP over a hidden span of c017 (seed
// 1791529129542, run sf-p1-prof-7) showed JS was not the cost (ScriptDuration
// 53 ms / 10.8 s) but CSS animations were still running on the hidden page:
// `spin`, `bounce`, `bounce-x-right` (job spinner, dashboard chevrons). With
// `backgroundThrottling: false` Chromium never learns the window is hidden, so
// those animations kept ticking: Compositor thread 360 ms + main thread
// 230 ms per 10.8 s, RecalcStyleCount 69, ProcessTime 0.70 s (6.4 %).
//
// Fix pinned here: while main reports the window hidden, the renderer marks
// <html data-app-window-hidden> and styles.css pauses every CSS animation
// under it; on show the mark goes away and animations resume where they were.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetAppWindowVisibilityForTests,
  __setAppWindowHiddenForTests,
} from "../src/renderer/src/lib/appWindowVisibility";

const LOG = "[hidden-renderer-animations]";
const STYLES = resolve(__dirname, "../src/renderer/src/styles.css");

afterEach(() => {
  __resetAppWindowVisibilityForTests();
});

describe("hidden app window pauses CSS animations (issue #25 P1 residual)", () => {
  it("marks <html> while main reports the window hidden and clears it on show", () => {
    const root = document.documentElement;
    const before = root.hasAttribute("data-app-window-hidden");
    __setAppWindowHiddenForTests({ hidden: true, atMs: 1, reason: "window-hide-event" });
    const whileHidden = root.hasAttribute("data-app-window-hidden");
    __setAppWindowHiddenForTests({ hidden: false, atMs: 2, reason: "window-show-event" });
    const afterShow = root.hasAttribute("data-app-window-hidden");
    console.info(`${LOG} attribute before=${before} hidden=${whileHidden} afterShow=${afterShow}`);
    expect({ before, whileHidden, afterShow }).toEqual({ before: false, whileHidden: true, afterShow: false });
  });

  it("styles.css pauses every animation under the hidden mark, except closing Radix exits", () => {
    const css = readFileSync(STYLES, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rule = /([^{}]*\[data-app-window-hidden\][^{}]*)\{([^{}]*)\}/.exec(css);
    const selectors = rule?.[1]?.split(",").map((s) => s.trim()) ?? [];
    const body = rule?.[2] ?? "";
    console.info(`${LOG} rule selectors=${JSON.stringify(selectors)} body=${JSON.stringify(body.trim())}`);
    expect(selectors.some((s) => s.endsWith("::before")) && selectors.some((s) => s.endsWith("::after"))).toBe(true);
    expect(body).toMatch(/animation-play-state:\s*paused\s*!important/);

    // Apply the shipped rule: a spinner pauses while hidden; a closing dialog
    // keeps its exit animation (Radix Presence unmounts it on animationend).
    // jsdom 30 drops the whole rule when its selector list contains a
    // pseudo-element selector (Chromium does not), so apply the element
    // selectors only; the ::before/::after coverage is asserted above.
    const style = document.createElement("style");
    style.textContent = `${selectors.filter((s) => !s.includes("::")).join(", ")} {${body}}`;
    document.head.append(style);
    document.body.innerHTML = `<svg data-testid="spinner" class="animate-spin"></svg><div data-testid="closing" data-state="closed"></div><div data-testid="open" data-state="open"></div>`;
    const state = () => Object.fromEntries(["spinner", "closing", "open"].map((id) => [id, getComputedStyle(document.querySelector(`[data-testid="${id}"]`)!).animationPlayState || "running"]));
    const visible = state();
    __setAppWindowHiddenForTests({ hidden: true, atMs: 1, reason: "window-hide-event" });
    const hidden = state();
    __setAppWindowHiddenForTests({ hidden: false, atMs: 2, reason: "window-show-event" });
    const shown = state();
    style.remove();
    document.body.innerHTML = "";
    console.info(`${LOG} animation-play-state visible=${JSON.stringify(visible)} hidden=${JSON.stringify(hidden)} shown=${JSON.stringify(shown)}`);
    expect(hidden).toEqual({ spinner: "paused", closing: "running", open: "paused" });
    expect(shown).toEqual({ spinner: "running", closing: "running", open: "running" });
  });
});
