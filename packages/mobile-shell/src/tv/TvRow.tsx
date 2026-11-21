import React, { Children, forwardRef, Fragment, memo, type ReactNode } from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { ChevronRight, type LucideIcon } from "lucide-react-native";
import { SkyCover } from "../components";
import { TvFocusable, type TvFocusableProps } from "./TvFocusable";
import type { TvViewInstance } from "./tvViewInstance";
import { useTvScale, useTvStyles } from "./tvScale";
import { TV_COLOR, TV_RADII, TV_TYPE, useTvAccent } from "./tokens";

/** What a row shows at its right end: a toggle, the current value with an arrow, an arrow alone, or nothing. */
export type TvRowEnd =
  | { kind: "toggle"; value: boolean }
  | { kind: "value"; value: string }
  | { kind: "chevron" }
  | { kind: "none" };

export type TvRowProps = Omit<TvFocusableProps, "style" | "children" | "ring" | "scale"> & {
  /** The small square icon before the title (lucide). */
  icon?: LucideIcon;
  title: string;
  /** The grey line under the title. */
  description?: string;
  end?: TvRowEnd;
  /** Red title (Sign out, Remove). */
  danger?: boolean;
  style?: StyleProp<ViewStyle>;
};

/**
 * A settings row (mockup `.li`, UX-TV-34): a square icon, the title with a grey line under it, and a toggle or the value
 * with an arrow at the right. It spans its list, so the focus ring sits inside its edge and it does not grow; the
 * focused row takes a faint tint of the accent. A toggle row is announced as a switch.
 */
export const TvRow = memo(
  forwardRef<TvViewInstance, TvRowProps>(({ icon: Icon, title, description, end = { kind: "chevron" }, danger, style, ...rest }, ref) => {
    const scale = useTvScale();
    const styles = useTvStyles(baseStyles);
    const accent = useTvAccent();
    const toggle = end.kind === "toggle";
    return (
      <TvFocusable
        ref={ref}
        ring="inside"
        scale={1}
        style={[styles.row, style]}
        focusedStyle={{ backgroundColor: accent.tint }}
        accessibilityRole={toggle ? "switch" : "button"}
        accessibilityLabel={end.kind === "value" ? `${title}, ${end.value}` : title}
        accessibilityHint={description}
        accessibilityState={toggle ? { checked: end.value } : undefined}
        {...rest}
      >
        {Icon ? (
          <View style={styles.icon} testID="tv-row-icon">
            <Icon size={13 * scale} color={TV_COLOR.text} />
          </View>
        ) : null}
        <View style={styles.text}>
          <Text style={[styles.title, danger && styles.danger]} numberOfLines={1}>
            {title}
          </Text>
          {description ? <Text style={styles.description}>{description}</Text> : null}
        </View>
        {end.kind === "toggle" ? <TvToggle on={end.value} /> : null}
        {end.kind === "value" ? (
          <View style={styles.value}>
            <Text style={styles.valueText} numberOfLines={1}>
              {end.value}
            </Text>
            <ChevronRight size={11 * scale} color={TV_COLOR.muted} />
          </View>
        ) : null}
        {end.kind === "chevron" ? <ChevronRight size={12 * scale} color={TV_COLOR.muted} /> : null}
      </TvFocusable>
    );
  }),
);
TvRow.displayName = "TvRow";

/** The pill toggle at a row's end (mockup `.toggle`): in the accent when on. It only shows the state; the row toggles it. */
export const TvToggle = memo(({ on }: { on: boolean }) => {
  const styles = useTvStyles(baseStyles);
  const accent = useTvAccent();
  return (
    <View style={[styles.toggle, on && [styles.toggleOn, { backgroundColor: accent.color }]]} testID={on ? "tv-toggle-on" : "tv-toggle-off"} accessible={false}>
      <View style={[styles.knob, on && { backgroundColor: accent.onColor }]} />
    </View>
  );
});
TvToggle.displayName = "TvToggle";

/** A group of rows in one rounded card (mockup `.list`), with a thin line between rows. */
export const TvRowList = memo(({ children, style, testID }: { children: ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) => {
  const styles = useTvStyles(baseStyles);
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <SkyCover style={[styles.list, style]} testID={testID}>
      {rows.map((row, index) => (
        <Fragment key={index}>
          {index > 0 ? <View style={styles.divider} /> : null}
          {row}
        </Fragment>
      ))}
    </SkyCover>
  );
});
TvRowList.displayName = "TvRowList";

/** Sizes in design dp (mockup px halved, scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  list: {
    borderRadius: TV_RADII.card,
    backgroundColor: TV_COLOR.listOnSky,
    borderWidth: 0.75,
    borderColor: "rgba(68, 71, 90, 0.55)",
    overflow: "hidden",
  },
  divider: { height: 0.75, backgroundColor: "rgba(68, 71, 90, 0.4)" },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: TV_RADII.card,
  },
  icon: {
    width: 26,
    height: 26,
    borderRadius: TV_RADII.control,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: TV_COLOR.secondary,
  },
  text: { flex: 1, gap: 2 },
  title: { ...TV_TYPE.body, color: TV_COLOR.text },
  danger: { color: TV_COLOR.danger },
  description: { ...TV_TYPE.small, color: TV_COLOR.muted },
  value: { flexDirection: "row", alignItems: "center", gap: 5, maxWidth: 220 },
  valueText: { fontFamily: TV_TYPE.body.fontFamily, fontSize: 11, fontWeight: "600", color: TV_COLOR.muted },
  toggle: {
    width: 36,
    height: 21,
    borderRadius: TV_RADII.pill,
    borderWidth: 0.75,
    borderColor: TV_COLOR.border,
    backgroundColor: TV_COLOR.secondary,
    justifyContent: "center",
    paddingHorizontal: 2,
  },
  toggleOn: { borderColor: "transparent", alignItems: "flex-end" },
  knob: { width: 14.5, height: 14.5, borderRadius: TV_RADII.pill, backgroundColor: TV_COLOR.muted },
});
