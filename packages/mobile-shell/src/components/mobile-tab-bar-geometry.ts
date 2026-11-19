/**
 * X (in px, from the bar's left edge) of the centre of tab `index`, given the
 * bar width and its horizontal padding. Tabs share the padded inner width
 * equally (flex: 1), so the slot centre must account for the padding.
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
