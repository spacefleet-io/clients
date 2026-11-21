/** The bar's horizontal padding on each side. */
export const TAB_BAR_PADDING_X = 12;
/**
 * The padding on each side while the bar holds an action: narrower, so French "BIBLIOTHÈQUE" keeps an 8 pt gap from
 * "ACCUEIL" in its half on a 360 dp phone (UX-PHONE-12).
 */
export const TAB_BAR_PADDING_X_WITH_ACTION = 6;
/** The width of the action's slot in the bar's centre: its circle (UX-PHONE-12). */
export const TAB_BAR_ACTION_SLOT = 36;
/** The smallest gap two neighbouring labels in one half may keep (UX-PHONE-12). */
export const TAB_BAR_MIN_LABEL_GAP = 8;

/**
 * X (in px, from the bar's left edge) of the centre of tab `index`, given the
 * bar width and its horizontal padding, as if the tabs shared the padded inner
 * width equally: the dot's place until the tabs are measured (they are as wide
 * as their labels, UX-PHONE-11), so the slot centre must account for the padding.
 */
export const tabIndicatorCenter = ({
  width,
  padding,
  count,
  index,
}: {
  width: number;
  padding: number;
  count: number;
  index: number;
}): number => {
  const slot = (width - padding * 2) / count;
  return padding + slot * index + slot / 2;
};

/** The width of each half either side of the action: the bar less its padding and the action's slot, halved. */
export const tabBarHalfWidth = (width: number, padding = TAB_BAR_PADDING_X_WITH_ACTION, action = TAB_BAR_ACTION_SLOT): number =>
  (width - padding * 2 - action) / 2;

/**
 * The dot's guess, before the tabs are measured, for tab `index` of the `half` tabs on one `side` of the action: the
 * half's room split equally between its tabs.
 */
export const tabBarHalfGuess = ({
  width,
  padding,
  action,
  half,
  side,
  index,
}: {
  width: number;
  padding: number;
  action: number;
  half: number;
  side: "left" | "right";
  index: number;
}): number => {
  const room = tabBarHalfWidth(width, padding, action);
  const start = side === "left" ? padding : padding + room + action;
  const slot = room / half;
  return start + slot * index + slot / 2;
};

/**
 * Whether labels of these widths fit one half of a bar `width` wide side by side, keeping TAB_BAR_MIN_LABEL_GAP between
 * neighbours and never shrinking a label (UX-PHONE-11, UX-PHONE-12). Each of the n tabs is as wide as its label plus an
 * equal 1/n of the room left, with its label centred, so two neighbouring labels are (room left)/n apart.
 */
export const tabBarHalfFits = (width: number, labelWidths: readonly number[]): boolean =>
  (tabBarHalfWidth(width) - labelWidths.reduce((sum, w) => sum + w, 0)) / labelWidths.length >= TAB_BAR_MIN_LABEL_GAP;
