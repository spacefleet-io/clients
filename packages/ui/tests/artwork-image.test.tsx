// @vitest-environment jsdom
/**
 * @test-id UI-ARTWORK-IMAGE-001
 * @level unit
 * @req UX-WAIT-03
 * @why Chris 2026-11-16: a poster still loading showed as a plain black box, which "looks like something is broken and
 *   doesn't say something is happening". The web player and desktop tile shows a small spinner while it waits, fades
 *   the picture in, and falls back to an icon with the title, never a spinner forever.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARTWORK_LOAD_TIMEOUT_MS, ARTWORK_SPINNER_DELAY_MS, type ArtworkSource } from "@space/shared/artworkImage";
import { ArtworkImage } from "../src/artwork-image";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const tile = () => container.querySelector<HTMLElement>('[data-testid="artwork-image"]')!;
const look = () => ({
  phase: tile().dataset.artwork,
  spinner: container.querySelector('[data-testid="artwork-spinner"]') !== null,
  fallback: container.querySelector('[data-testid="artwork-fallback"]')?.textContent ?? null,
  img: container.querySelector("img")?.getAttribute("src") ?? null,
  shown: container.querySelector("img")?.classList.contains("opacity-100") ?? false,
});
const show = (source: ArtworkSource, decorative = false) =>
  act(() => root.render(<ArtworkImage source={source} alt="" label="Heat" decorative={decorative} />));

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("ArtworkImage (UX-WAIT-03)", () => {
  it("shows the spinner while the picture is fetched, then fades the picture in once drawn", () => {
    show({ kind: "pending" });
    const waiting = look();
    show({ kind: "url", url: "blob:heat" });
    const drawing = look();
    act(() => container.querySelector("img")!.dispatchEvent(new Event("load")));
    const loaded = look();
    console.info("[UI-ARTWORK-IMAGE-001] looks", JSON.stringify({ waiting, drawing, loaded }));
    expect(waiting).toEqual({ phase: "loading", spinner: true, fallback: null, img: null, shown: false });
    expect(drawing).toEqual({ phase: "loading", spinner: true, fallback: null, img: "blob:heat", shown: false });
    expect(loaded).toEqual({ phase: "loaded", spinner: false, fallback: null, img: "blob:heat", shown: true });
  });

  it("the spinner waits 150 ms before it shows and stands still under reduced motion", () => {
    show({ kind: "pending" });
    const sheet = [...document.querySelectorAll("style")].map((s) => s.textContent ?? "").find((css) => css.includes("sf-artwork-spinner")) ?? "";
    expect(ARTWORK_SPINNER_DELAY_MS).toBe(150);
    expect(sheet).toMatch(/\.sf-artwork-spinner \{ animation: sf-artwork-in 200ms ease-out 150ms both; \}/u);
    expect(sheet).toMatch(/prefers-reduced-motion: reduce\) \{ \.sf-artwork-spinner > i \{ animation: none; \}/u);
  });

  it("a picture that will not draw shows the icon and the title", () => {
    show({ kind: "url", url: "blob:broken" });
    act(() => container.querySelector("img")!.dispatchEvent(new Event("error")));
    const failed = look();
    console.info("[UI-ARTWORK-IMAGE-001] error", JSON.stringify(failed));
    expect(failed).toEqual({ phase: "failed", spinner: false, fallback: "Heat", img: null, shown: false });
    expect(container.querySelector('[data-testid="artwork-fallback"] svg')).not.toBeNull();
  });

  it("no picture at all shows the fallback at once; a stalled fetch moves to it after 15 s, never a spinner forever", () => {
    show({ kind: "none" });
    expect(look()).toEqual({ phase: "failed", spinner: false, fallback: "Heat", img: null, shown: false });
    act(() => root.render(<ArtworkImage key="other" source={{ kind: "pending" }} alt="" label="Alien" />));
    act(() => vi.advanceTimersByTime(ARTWORK_LOAD_TIMEOUT_MS - 1));
    const before = look();
    act(() => vi.advanceTimersByTime(1));
    const after = look();
    console.info("[UI-ARTWORK-IMAGE-001] stall", JSON.stringify({ before, after }));
    expect(before.phase).toBe("loading");
    expect(after).toEqual({ phase: "failed", spinner: false, fallback: "Alien", img: null, shown: false });
  });

  it("a decorative backdrop only fades in: no spinner, no fallback", () => {
    show({ kind: "pending" }, true);
    expect(look()).toEqual({ phase: "loading", spinner: false, fallback: null, img: null, shown: false });
    show({ kind: "none" }, true);
    expect(look()).toEqual({ phase: "failed", spinner: false, fallback: null, img: null, shown: false });
  });
});
