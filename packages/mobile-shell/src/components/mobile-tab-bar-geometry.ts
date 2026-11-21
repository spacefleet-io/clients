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
