// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AppBackdrop from "../src/app-backdrop";

const motion = (root: ParentNode) => root.querySelector<HTMLElement>('[data-testid="app-backdrop"]')!.dataset.skyMotion;

// @req UX-SKY-02
describe("the apps draw the website hero's sky", () => {
  it("renders the hero's 150 still stars and 3 looping shooting stars", () => {
    const html = renderToStaticMarkup(<AppBackdrop />);
    const count = (id: string) => (html.match(new RegExp(`data-testid="${id}"`, "g")) ?? []).length;
    console.log("[sky] app stars", count("sky-star"), "shooting", count("sky-shooting-star"));
    expect(count("sky-star")).toBe(150);
    expect(count("sky-shooting-star")).toBe(3);
    expect(html).toContain("@keyframes sf-shooting-star");
  });

  it("draws the stars as one still SVG: nothing in the app's sky animates but the shooting stars", () => {
    const { container } = render(<AppBackdrop />);
    const layers = container.querySelectorAll('[data-testid="sky-stars"]');
    const stars = [...container.querySelectorAll<SVGElement>('[data-testid="sky-star"]')];
    const animated = [...container.querySelectorAll<HTMLElement>("[style]")].filter((el) => /animation/.test(el.getAttribute("style") ?? ""));
    console.log("[sky] star layers", layers.length, "stars", stars.length, "animated", animated.map((el) => el.dataset.testid), "first", stars[0]?.outerHTML);
    expect(layers).toHaveLength(1);
    expect(layers[0]!.tagName.toLowerCase()).toBe("svg");
    expect(stars).toHaveLength(150);
    expect(stars.every((star) => star.parentElement === layers[0])).toBe(true);
    expect(stars.every((star) => !star.getAttribute("style") && !star.getAttribute("class"))).toBe(true);
    expect(layers[0]!.querySelectorAll("animate, animateTransform, animateMotion, set")).toHaveLength(0);
    expect(container.querySelectorAll(".sf-sky-star")).toHaveLength(0);
    expect(animated.map((el) => el.dataset.testid)).toEqual(["sky-shooting-star", "sky-shooting-star", "sky-shooting-star"]);
    cleanup();
  });
});

// @req UX-SKY-01
describe("the apps' sky holds still while the user interacts, stops during playback", () => {
  let reducedMotion: boolean;
  beforeEach(() => {
    vi.useFakeTimers();
    reducedMotion = false;
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: reducedMotion && query.includes("prefers-reduced-motion"),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.documentElement.removeAttribute("data-app-playback");
    document.documentElement.removeAttribute("data-app-window-hidden");
    document.documentElement.removeAttribute("data-app-busy");
  });
  const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

  it("moves when idle, holds still from the first input until 5 s of quiet", () => {
    const { container } = render(<AppBackdrop />);
    console.log("[sky] mounted", motion(container));
    expect(motion(container)).toBe("live");
    act(() => void window.dispatchEvent(new Event("pointermove")));
    expect(motion(container)).toBe("still");
    advance(4_000);
    act(() => void window.dispatchEvent(new Event("wheel")));
    advance(4_999);
    expect(motion(container)).toBe("still");
    advance(1);
    expect(motion(container)).toBe("live");
  });

  it("stops during playback (<html data-app-playback>) and moves again after it", async () => {
    const { container } = render(<AppBackdrop />);
    await act(async () => document.documentElement.setAttribute("data-app-playback", ""));
    expect(motion(container)).toBe("off");
    await act(async () => document.documentElement.removeAttribute("data-app-playback"));
    expect(motion(container)).toBe("live");
  });

  it("[@bugfix][@regression-proof] stops while the app marks its window hidden (<html data-app-window-hidden>)", async () => {
    const { container } = render(<AppBackdrop />);
    await act(async () => document.documentElement.setAttribute("data-app-window-hidden", ""));
    expect(motion(container)).toBe("off");
    await act(async () => document.documentElement.removeAttribute("data-app-window-hidden"));
    expect(motion(container)).toBe("live");
  });

  it("[@bugfix #2461][@regression-proof] stops while the app processes media (<html data-app-busy>) and moves again after it", async () => {
    const { container } = render(<AppBackdrop />);
    await act(async () => document.documentElement.setAttribute("data-app-busy", ""));
    const during = motion(container);
    await act(async () => document.documentElement.removeAttribute("data-app-busy"));
    const after = motion(container);
    console.log("[sky] busy", during, "after", after);
    expect(during).toBe("off");
    expect(after).toBe("live");
  });

  it("never moves when the user prefers reduced motion", () => {
    reducedMotion = true;
    const { container } = render(<AppBackdrop />);
    advance(60_000);
    expect(motion(container)).toBe("off");
  });

  it("removes the shooting stars when still or off, so nothing schedules frames", () => {
    const html = renderToStaticMarkup(<AppBackdrop />);
    expect(html).toContain('[data-sky-motion="still"] .sf-shooting-star, [data-sky-motion="off"] .sf-shooting-star { display: none; }');
    // Server markup starts "off": nothing moves before the app says it may.
    expect(html).toContain('data-sky-motion="off"');
  });

  // @req UX-SKY-03
  it("paints the app's nebula under the stars: Parrot green, Badger yellow, none by default", () => {
    const parrot = renderToStaticMarkup(<AppBackdrop nebula="parrot" />);
    const badger = renderToStaticMarkup(<AppBackdrop nebula="badger" />);
    const plain = renderToStaticMarkup(<AppBackdrop />);
    console.info("[app-backdrop] nebula", { parrot: parrot.slice(0, 400), badger: badger.slice(0, 400) });
    expect(parrot).toContain("hsl(150 75% 45% / 0.35)");
    expect(badger).toContain("hsl(33 100% 67% / 0.35)");
    expect(plain).not.toContain("radial-gradient");
  });
});
