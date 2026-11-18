import React, { forwardRef, memo, type ReactNode } from "react";
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { TvFocusable, type TvFocusableProps } from "../components/TvFocusable";
import type { TvViewInstance } from "../lib/tvViewInstance";
import { useTvScale, useTvStyles } from "../lib/tvScale";
import { TV_COLOR, TV_RADII, TV_TYPE } from "./tokens";

export type TvChipProps = Omit<TvFocusableProps, "style" | "children" | "ring"> & {
  label: string;
  icon?: LucideIcon;
  /** Drawn after the label in the same colour (the sort chip's "⌄"). */
  iconEnd?: LucideIcon;
  /** The chosen chip: amber fill, dark text. */
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
};

/**
 * A chip (mockup `.chip`, UX-TV-34): a small pill for a choice or a sort ("A to Z", "English"). The chosen one is amber;
 * the focus ring sits outside with a gap like every TV control.
 */
export const TvChip = memo(
  forwardRef<TvViewInstance, TvChipProps>(({ label, icon: Icon, iconEnd: IconEnd, selected, style, ...rest }, ref) => {
    const scale = useTvScale();
    const styles = useTvStyles(baseStyles);
    const color = selected ? TV_COLOR.onAmber : TV_COLOR.muted;
    return (
      <TvFocusable
        ref={ref}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: selected === true }}
        {...rest}
        style={[styles.chip, selected && styles.chipSelected, style]}
      >
        {Icon ? <Icon size={11 * scale} color={color} /> : null}
        <Text style={[styles.label, { color }]} numberOfLines={1}>
          {label}
        </Text>
        {IconEnd ? <IconEnd size={11 * scale} color={color} /> : null}
      </TvFocusable>
    );
  }),
);
TvChip.displayName = "TvChip";

/** One choice: `lead` is drawn before the label (a language's flag); `icon` is the lucide alternative. */
export type TvSegmentedOption<T extends string> = { value: T; label: string; icon?: LucideIcon; lead?: ReactNode };

export type TvSegmentedProps<T extends string> = {
  options: readonly TvSegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** The tray's test id; each choice is `<testID>-<value>`. */
  testID?: string;
  /** The choice that takes the focus when the screen opens. */
  preferredValue?: T;
  /** Called when a choice takes the focus. */
  onFocusOption?: (value: T) => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * A segmented control (mockup `.seg`, UX-TV-34): choices side by side in one rounded tray, the chosen one amber
 * ("Films | Series", "Light | Dark"). Left and right move between the choices; OK picks one.
 */
function TvSegmentedInner<T extends string>({ options, value, onChange, testID, preferredValue, onFocusOption, style }: TvSegmentedProps<T>) {
  const scale = useTvScale();
  const styles = useTvStyles(baseStyles);
  return (
    <View style={[styles.tray, style]} testID={testID} accessibilityRole="radiogroup">
      {options.map((option) => {
        const chosen = option.value === value;
        const color = chosen ? TV_COLOR.onAmber : TV_COLOR.muted;
        const Icon = option.icon;
        return (
          <TvFocusable
            key={option.value}
            testID={testID ? `${testID}-${option.value}` : undefined}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked: chosen }}
            hasTVPreferredFocus={preferredValue === option.value}
            onPress={() => onChange(option.value)}
            onFocus={onFocusOption ? () => onFocusOption(option.value) : undefined}
            style={[styles.segment, chosen && styles.chipSelected]}
          >
            {option.lead ?? null}
            {Icon ? <Icon size={11 * scale} color={color} /> : null}
            <Text style={[styles.label, { color }]} numberOfLines={1}>
              {option.label}
            </Text>
          </TvFocusable>
        );
      })}
    </View>
  );
}
export const TvSegmented = memo(TvSegmentedInner) as typeof TvSegmentedInner;

/** Sizes in design dp (mockup px halved, scaled with the TV, UX-TV-13). */
const baseStyles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 30,
    paddingHorizontal: 13,
    borderRadius: TV_RADII.pill,
    backgroundColor: "rgba(36, 38, 56, 0.75)",
    borderWidth: 0.75,
    borderColor: TV_COLOR.borderSoft,
  },
  chipSelected: { backgroundColor: TV_COLOR.amber, borderColor: "transparent" },
  label: { fontFamily: TV_TYPE.body.fontFamily, fontSize: 11, fontWeight: "700" },
  tray: {
    flexDirection: "row",
    alignSelf: "flex-start",
    gap: 3,
    padding: 3,
    borderRadius: TV_RADII.tray,
    backgroundColor: "rgba(36, 38, 56, 0.8)",
    borderWidth: 0.75,
    borderColor: TV_COLOR.borderSoft,
  },
  segment: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 27,
    paddingHorizontal: 13,
    borderRadius: 6.5,
  },
});
