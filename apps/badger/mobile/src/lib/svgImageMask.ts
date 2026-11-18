/**
 * The box of every react-native-svg `<Mask>` that fades an `<Image>` (UX-PHONE-04 hero, UX-TV-06 backdrop): the whole Svg,
 * in the Svg's own user space. DETAILS-HERO-BLANK-001: with the default `maskUnits="objectBoundingBox"`, react-native-svg
 * on iOS sizes the mask from the image's own bounds, and on the iOS 26 simulator (Badger 0.1.2) that left nothing of the
 * picture: the title page hero was blank on every title, while a masked Rect and an unmasked Image both drew. In user
 * space the mask box comes from the Svg's size instead, so the picture draws with its fade on iOS and Android alike. The
 * masked image fills the Svg, so the box is the same one as before.
 */
export const SVG_IMAGE_MASK_BOX = {
  x: "0",
  y: "0",
  width: "100%",
  height: "100%",
  maskUnits: "userSpaceOnUse",
} as const;
