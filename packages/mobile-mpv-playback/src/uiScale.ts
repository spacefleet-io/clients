/**
 * Multiplies the lengths of React Native styles by a UI scale. The TV interfaces are drawn for a 960x540 design screen
 * (Android TV at 1080p) and scaled to the real window: 1 on Android TV, 2 on an Apple TV's 1920x1080 points (UX-TV-13).
 * Pure (no react-native import) so the app's TV screens and this package's player controls share one implementation.
 */

/** Style keys holding a length: scaled. Everything else (flex, opacity, zIndex, colours, weights, percentages) is not. */
const LENGTH_KEY_LIST = [
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "flexBasis",
  "top",
  "bottom",
  "left",
  "right",
  "start",
  "end",
  "inset",
  "insetBlock",
  "insetInline",
  "margin",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "marginStart",
  "marginEnd",
  "marginHorizontal",
  "marginVertical",
  "padding",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "paddingStart",
  "paddingEnd",
  "paddingHorizontal",
  "paddingVertical",
  "gap",
  "rowGap",
  "columnGap",
  "borderRadius",
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomLeftRadius",
  "borderBottomRightRadius",
  "borderTopStartRadius",
  "borderTopEndRadius",
  "borderBottomStartRadius",
  "borderBottomEndRadius",
  "borderWidth",
  "borderTopWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderRightWidth",
  "borderStartWidth",
  "borderEndWidth",
  "outlineWidth",
  "outlineOffset",
  "shadowRadius",
  "textShadowRadius",
  "elevation",
  "translateX",
  "translateY",
] as const;
const LENGTH_KEYS: Record<string, true> = Object.fromEntries(LENGTH_KEY_LIST.map((key) => [key, true]));
/** Keys holding `{ width, height }` offsets. */
const OFFSET_KEYS: Record<string, true> = { shadowOffset: true, textShadowOffset: true };

const scaleValue = (key: string, value: unknown, scale: number): unknown => {
  if (typeof value === "number") return LENGTH_KEYS[key] ? value * scale : value;
  if (Array.isArray(value)) return value.map((entry) => scaleValue(key, entry, scale));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [inner, innerValue] of Object.entries(value)) {
      if (OFFSET_KEYS[key] && typeof innerValue === "number") out[inner] = innerValue * scale;
      else out[inner] = scaleValue(inner, innerValue, scale);
    }
    return out;
  }
  return value;
};

/** One style (or a style array, as passed to `style=`) with every length multiplied by the scale. */
export const scaleStyle = <T>(style: T, scale: number): T => (scale === 1 ? style : (scaleValue("", style, scale) as T));

const sheetCache = new WeakMap<object, Map<number, unknown>>();

/**
 * A `StyleSheet.create` block drawn in design dp at this scale; memoised per sheet and scale so every render at one
 * window size shares one object. At scale 1 the sheet itself is returned.
 */
export const scaleStyleSheet = <T extends object>(styles: T, scale: number): T => {
  if (scale === 1) return styles;
  let byScale = sheetCache.get(styles);
  if (!byScale) {
    byScale = new Map();
    sheetCache.set(styles, byScale);
  }
  let scaled = byScale.get(scale) as T | undefined;
  if (!scaled) {
    scaled = {} as T;
    for (const [name, style] of Object.entries(styles)) (scaled as Record<string, unknown>)[name] = scaleStyle(style, scale);
    byScale.set(scale, scaled);
  }
  return scaled;
};
