// @vitest-environment jsdom
// @bugfix UX-HOME-01: a click on a Home poster's title or year opened nothing — the carousel made every press a drag
// (cards `pointer-events-none` on mousedown), so the mouseup landed on the scroller and the card never got its click.

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DRAG_SCROLL_THRESHOLD_PX, useDragScroll } from "../src/renderer/src/lib/useDragScroll";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const log = (...args: unknown[]) => console.log("[use-drag-scroll]", ...args);

const Row = ({ onSelect }: { onSelect: () => void }) => {
  const { scrollerRef, isDragging, wasDrag, handlers } = useDragScroll<HTMLDivElement>();
  return (
    <div ref={scrollerRef} data-testid="scroller" data-dragging={isDragging ? "yes" : "no"} {...handlers}>
      <div
        data-testid="card"
        className={isDragging ? "pointer-events-none" : ""}
        onClick={() => {
          if (wasDrag()) return;
          onSelect();
        }}
      >
        <div data-testid="title">Amélie</div>
      </div>
    </div>
  );
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const mount = (onSelect: () => void) => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Row onSelect={onSelect} />));
  const get = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  return { scroller: get("scroller"), card: get("card"), title: get("title") };
};

const mouse = (target: HTMLElement, type: string, pageX: number) => {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: pageX });
  Object.defineProperty(event, "pageX", { value: pageX });
  act(() => {
    target.dispatchEvent(event);
  });
};

const snapshot = (els: { scroller: HTMLElement; card: HTMLElement }) => ({
  dragging: els.scroller.dataset.dragging,
  cardClass: els.card.className,
  scrollLeft: els.scroller.scrollLeft,
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe("useDragScroll (UX-HOME-01)", () => {
  it("a press without movement stays a click: the card keeps its pointer events and opens", () => {
    const onSelect = vi.fn();
    const els = mount(onSelect);
    mouse(els.title, "mousedown", 100);
    log("after mousedown", snapshot(els));
    expect(els.card.className).not.toContain("pointer-events-none");
    mouse(els.title, "mousemove", 100 + DRAG_SCROLL_THRESHOLD_PX - 1);
    log("after jitter move", snapshot(els));
    expect(els.scroller.dataset.dragging).toBe("no");
    mouse(els.title, "mouseup", 102);
    mouse(els.title, "click", 102);
    log("after click", snapshot(els), "onSelect calls", onSelect.mock.calls.length);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("a press that moves past the threshold scrolls the row and its click opens nothing", () => {
    const onSelect = vi.fn();
    const els = mount(onSelect);
    els.scroller.scrollLeft = 300;
    mouse(els.title, "mousedown", 200);
    mouse(els.title, "mousemove", 150);
    log("mid drag", snapshot(els));
    expect(els.scroller.dataset.dragging).toBe("yes");
    expect(els.card.className).toContain("pointer-events-none");
    mouse(els.scroller, "mouseup", 150);
    mouse(els.card, "click", 150);
    log("after drag click", snapshot(els), "onSelect calls", onSelect.mock.calls.length);
    expect(els.scroller.dataset.dragging).toBe("no");
    expect(onSelect).not.toHaveBeenCalled();

    // The next plain press is a click again.
    mouse(els.title, "mousedown", 150);
    mouse(els.title, "mouseup", 150);
    mouse(els.title, "click", 150);
    log("after next plain click", "onSelect calls", onSelect.mock.calls.length);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
