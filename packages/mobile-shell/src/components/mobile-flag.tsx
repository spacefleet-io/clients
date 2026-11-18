import React from "react";
import { View } from "react-native";
import { SvgXml } from "react-native-svg";
import { FLAG_SVGS } from "@space/shared/languageFlags";

/**
 * A language's flag for every phone and TV language picker (UX-I18N-10): the same Noto emoji artwork as `Flag` in
 * @space/ui (desktop and the web), drawn from its SVG, never emoji text, which shows as the letters "GB", "FR"… on
 * Android TVs and phones without a flag font. English is the British flag; any other code draws nothing.
 */
const LANGUAGE_FLAG_CODES = ["en", "fr", "nl", "de", "es"] as const;
type LanguageFlagCode = (typeof LANGUAGE_FLAG_CODES)[number];

/** A flag fitted, centred, in a 3:2 box `width` wide (24 by default). */
export const MobileFlag = ({ code, width = 24 }: { code: string; width?: number }) => {
  if (!(LANGUAGE_FLAG_CODES as readonly string[]).includes(code)) return null;
  const height = (width * 2) / 3;
  return (
    <View testID={`flag-${code}`} style={{ width, height }} accessible={false} importantForAccessibility="no-hide-descendants">
      <SvgXml xml={FLAG_SVGS[code as LanguageFlagCode]} width={width} height={height} preserveAspectRatio="xMidYMid meet" />
    </View>
  );
};
