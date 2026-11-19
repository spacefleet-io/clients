/** An eased (ease-in-out) opacity ramp, so a fade has no visible start or end line. */
const EASED_ALPHAS = [0, 0.013, 0.049, 0.104, 0.175, 0.259, 0.352, 0.45, 0.55, 0.648, 0.741, 0.825, 0.896, 0.951, 0.987, 1];

/**
 * A CSS mask that fades from nothing at `from`% to full at `to`% along `direction` (full to nothing with `reverse`),
 * along the eased ramp. A mask applies after `filter`, so it also fades the soft band a `blur()` leaves at a box's edge.
 */
export const easedMask = (direction: string, from: number, to: number, reverse = false) =>
  `linear-gradient(${direction}, ${EASED_ALPHAS.map((alpha, index) => {
    const at = from + ((to - from) * index) / (EASED_ALPHAS.length - 1);
    return `rgba(0,0,0,${reverse ? 1 - alpha : alpha}) ${at.toFixed(1)}%`;
  }).join(", ")})`;
