import React, { memo } from "react";
import { StyleSheet, Text, type TextProps } from "react-native";
import { useTvStyles } from "./tvScale";
import { TV_COLOR, TV_EYEBROW, TV_TYPE, useTvAccent } from "./tokens";

/** The TV's text in the family type (UX-TV-34): Space Grotesk titles, Inter body, accent spaced-capital eyebrows. */

export type TvTitleSize = "hero" | "page" | "section";

/** A title in Space Grotesk: `hero` for the title of a film, `page` for a screen or card title, `section` for a row heading. */
export const TvTitle = memo(({ size = "page", style, ...rest }: TextProps & { size?: TvTitleSize }) => {
  const styles = useTvStyles(baseStyles);
  return <Text accessibilityRole="header" {...rest} style={[styles[size], style]} />;
});
TvTitle.displayName = "TvTitle";

export type TvBodySize = "body" | "caption" | "small";

/** Body text in Inter; `muted` for grey-blue secondary lines. */
export const TvBody = memo(({ size = "body", muted, style, ...rest }: TextProps & { size?: TvBodySize; muted?: boolean }) => {
  const styles = useTvStyles(baseStyles);
  return <Text {...rest} style={[styles[size], muted && styles.muted, style]} />;
});
TvBody.displayName = "TvBody";

/**
 * The small label in spaced capitals over a title or a group: in the app's accent over a title ("CONTINUE WATCHING",
 * "STEP 1 OF 2"), `muted` grey over a group of settings ("QUALITY AND LANGUAGES").
 */
export const TvEyebrow = memo(({ tone = "accent", style, ...rest }: TextProps & { tone?: "accent" | "muted" }) => {
  const styles = useTvStyles(baseStyles);
  const accent = useTvAccent().color;
  return <Text {...rest} style={[styles.eyebrow, tone === "muted" ? styles.muted : { color: accent }, style]} />;
});
TvEyebrow.displayName = "TvEyebrow";

/** Sizes in design dp (scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  hero: { ...TV_TYPE.hero, color: TV_COLOR.text },
  page: { ...TV_TYPE.page, color: TV_COLOR.text },
  section: { ...TV_TYPE.section, color: TV_COLOR.text },
  body: { ...TV_TYPE.body, color: TV_COLOR.text },
  caption: { ...TV_TYPE.caption, color: TV_COLOR.text },
  small: { ...TV_TYPE.small, color: TV_COLOR.text },
  muted: { color: TV_COLOR.muted },
  eyebrow: TV_EYEBROW,
});
