/**
 * @test-id MOBILE-SHELL-SKY-COVERS-001
 * @level unit
 * @why UX-SKY-01 on mobile: a scroll in motion (drag or momentum) holds the
 *   sky still like a held finger, and a drag released into momentum stays one
 *   scroll. Shooting stars fly anywhere (UX-SKY-02), so nothing is measured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSkyCoverRegistry, createSkyScrollHandlers, SKY_SCROLL_SETTLE_MS } from "../src/components/mobile-sky-covers";

describe("createSkyCoverRegistry: scrolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const setup = () => {
    const covers = createSkyCoverRegistry();
    const seen: boolean[] = [];
    covers.subscribeScrolling((scrolling) => seen.push(scrolling));
    return { covers, seen };
  };

  // @req UX-SKY-01[badger-mobile]
  it("holds from the first drag until the momentum ends, then releases after the settle time", () => {
    const { covers, seen } = setup();
    const list = createSkyScrollHandlers(covers);

    list.onScrollBeginDrag();
    expect(covers.isScrolling()).toBe(true);
    list.onScrollEndDrag();
    list.onMomentumScrollBegin();
    // The finger lifted, the list still coasts: still one scroll.
    vi.advanceTimersByTime(10 * SKY_SCROLL_SETTLE_MS);
    expect(covers.isScrolling()).toBe(true);

    list.onMomentumScrollEnd();
    expect(covers.isScrolling()).toBe(true);
    vi.advanceTimersByTime(SKY_SCROLL_SETTLE_MS);
    console.info(`[mobile-sky-covers:test] scrolling transitions=${JSON.stringify(seen)}`);
    expect(seen).toEqual([true, false]);
  });

  // @req UX-SKY-01[badger-mobile]
  it("settles after a drag released without momentum", () => {
    const { covers, seen } = setup();
    const list = createSkyScrollHandlers(covers);
    list.onScrollBeginDrag();
    list.onScrollEndDrag();
    vi.advanceTimersByTime(SKY_SCROLL_SETTLE_MS - 1);
    expect(covers.isScrolling()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([true, false]);
  });

  // @req UX-SKY-01[badger-mobile]
  it("stays held while any of several sources (page pager, list, rail) still moves", () => {
    const { covers, seen } = setup();
    const pager = createSkyScrollHandlers(covers);
    const list = createSkyScrollHandlers(covers);
    pager.onScrollBeginDrag();
    list.onMomentumScrollBegin();
    pager.onMomentumScrollEnd();
    vi.advanceTimersByTime(10 * SKY_SCROLL_SETTLE_MS);
    expect(covers.isScrolling()).toBe(true);
    list.onMomentumScrollEnd();
    vi.advanceTimersByTime(SKY_SCROLL_SETTLE_MS);
    expect(seen).toEqual([true, false]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores an end event from a source that never began", () => {
    const { covers, seen } = setup();
    createSkyScrollHandlers(covers).onMomentumScrollEnd();
    expect(vi.getTimerCount()).toBe(0);
    expect(seen).toEqual([]);
  });
});
