/**
 * Drag-to-scroll for a horizontal row (the Home carousels). A press only becomes a drag once the pointer has moved
 * more than {@link DRAG_SCROLL_THRESHOLD_PX}; until then the press is a click and the card under it gets it. The old
 * carousel turned every press into a drag (cards went `pointer-events-none` on mousedown), so the mouseup landed on the
 * scroller and a click on a poster's title or year never opened the title (UX-HOME-01).
 */
import { useCallback, useRef, useState, type MouseEvent } from "react";

/** How far (px) the pointer moves before a press counts as a drag rather than a click. */
export const DRAG_SCROLL_THRESHOLD_PX = 5;

/** Scroll distance per pointer pixel while dragging. */
const DRAG_SCROLL_SPEED = 2;

export const useDragScroll = <T extends HTMLElement>() => {
  const scrollerRef = useRef<T | null>(null);
  const startRef = useRef<{ x: number; scrollLeft: number } | null>(null);
  const draggedRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);

  const onMouseDown = useCallback((event: MouseEvent) => {
    const scroller = scrollerRef.current;
    if (!scroller || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    startRef.current = { x: event.pageX, scrollLeft: scroller.scrollLeft };
    draggedRef.current = false;
  }, []);

  const onMouseMove = useCallback((event: MouseEvent) => {
    const start = startRef.current;
    const scroller = scrollerRef.current;
    if (!start || !scroller) return;
    const dx = event.pageX - start.x;
    if (!draggedRef.current && Math.abs(dx) <= DRAG_SCROLL_THRESHOLD_PX) return;
    if (!draggedRef.current) {
      draggedRef.current = true;
      setIsDragging(true);
    }
    event.preventDefault();
    scroller.scrollLeft = start.scrollLeft - dx * DRAG_SCROLL_SPEED;
  }, []);

  const end = useCallback(() => {
    startRef.current = null;
    setIsDragging(false);
  }, []);

  /** True when the last press moved past the threshold: the click that ends it must not open anything. */
  const wasDrag = useCallback(() => draggedRef.current, []);

  return {
    scrollerRef,
    isDragging,
    wasDrag,
    handlers: { onMouseDown, onMouseMove, onMouseUp: end, onMouseLeave: end },
  };
};
