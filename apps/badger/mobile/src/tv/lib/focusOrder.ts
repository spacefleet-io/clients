/** Where the remote's focus starts and how a rail follows it: pure, so the order is testable without a TV. */

export type FocusTarget = { railIndex: number; itemIndex: number };

/** The card focused when Home opens: the first card of the first rail that has titles (null when there is none). */
export const preferredFocusTarget = (rails: readonly { items: readonly unknown[] }[]): FocusTarget | null => {
  const railIndex = rails.findIndex((rail) => rail.items.length > 0);
  return railIndex < 0 ? null : { railIndex, itemIndex: 0 };
};

/** Whether the card at `railIndex` / `itemIndex` takes the preferred focus. */
export const isPreferredFocus = (target: FocusTarget | null, railIndex: number, itemIndex: number): boolean =>
  target !== null && target.railIndex === railIndex && target.itemIndex === itemIndex;

/**
 * Horizontal scroll offset that follows the focus along a rail: the focused card sits second from the left (the
 * previous one peeks, so left is visibly possible) and the rail never scrolls past its ends.
 */
export const railScrollOffset = (params: {
  focusedIndex: number;
  itemLength: number;
  itemCount: number;
  viewportWidth: number;
}): number => {
  const { focusedIndex, itemLength, itemCount, viewportWidth } = params;
  const maxOffset = Math.max(0, itemCount * itemLength - viewportWidth);
  return Math.min(maxOffset, Math.max(0, (focusedIndex - 1) * itemLength));
};
