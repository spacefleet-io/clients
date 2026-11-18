import React, { memo } from "react";
import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { Check, ChevronRight } from "lucide-react-native";
import { BottomSheet } from "./BottomSheet";
import { usePickerSheet } from "./usePickerSheet";
import { SkyCover } from "@space/mobile-shell/components";
import { MobileSheetScrollView } from "@space/mobile-shell/bottom-sheet";
import { theme } from "../theme/theme";
import { panelCardStyle } from "./Panel";
import { RIPPLE } from "./PosterCard";
import { choiceOpensWindow } from "../lib/choiceLayout";

export const SettingsGroup = memo(({ title, children }: { title?: string; children: React.ReactNode }) => (
  <View style={styles.group}>
    {title ? (
      <Text style={styles.groupTitle} accessibilityRole="header">
        {title}
      </Text>
    ) : null}
    <SkyCover style={styles.card}>{children}</SkyCover>
  </View>
));
SettingsGroup.displayName = "SettingsGroup";

type SwitchRowProps = {
  title: string;
  description?: string;
  /** Shown under the description, e.g. a small link (REL-LOG-06's "What's in a report?"). */
  extra?: React.ReactNode;
  value: boolean;
  onValueChange: (value: boolean) => void;
  testID?: string;
};

/** Whole row toggles; 56dp tall; announced as a switch. */
export const SwitchRow = memo(({ title, description, extra, value, onValueChange, testID }: SwitchRowProps) => (
  <Pressable
    style={styles.row}
    testID={testID}
    onPress={() => onValueChange(!value)}
    android_ripple={RIPPLE}
    accessibilityRole="switch"
    accessibilityLabel={title}
    accessibilityHint={description}
    accessibilityState={{ checked: value }}
  >
    <View style={styles.rowText}>
      <Text style={styles.rowTitle}>{title}</Text>
      {description ? <Text style={styles.rowDescription}>{description}</Text> : null}
      {extra}
    </View>
    <Switch
      value={value}
      onValueChange={onValueChange}
      trackColor={{ false: theme.colors.surfaceRaised, true: theme.colors.accentSoft }}
      thumbColor={value ? theme.colors.accent : theme.colors.textDim}
      accessible={false}
      importantForAccessibility="no"
    />
  </Pressable>
));
SwitchRow.displayName = "SwitchRow";

type ChoiceRowProps<T extends string> = {
  title: string;
  description?: string;
  /** `lead` is drawn before the label, e.g. a language's flag (UX-I18N-10). */
  options: readonly { value: T; label: string; lead?: React.ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  testID?: string;
};

/** Single choice: chips inline for a short list, else one row that opens a scrolling sheet (`PickerRow`, UX-LIST-01). */
export const ChoiceRow = <T extends string>(props: ChoiceRowProps<T>) =>
  choiceOpensWindow(props.options.length) ? <PickerRow {...props} /> : <InlineChoice {...props} />;

const InlineChoice = <T extends string>({ title, description, options, value, onChange, testID }: ChoiceRowProps<T>) => (
  <View style={styles.choiceWrap} testID={testID}>
    <Text style={styles.rowTitle}>{title}</Text>
    {description ? <Text style={styles.rowDescription}>{description}</Text> : null}
    <View style={styles.chips} accessibilityRole="radiogroup">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            testID={testID ? `${testID}-${option.value}` : undefined}
            style={[styles.chip, selected && styles.chipSelected]}
            onPress={() => onChange(option.value)}
            android_ripple={RIPPLE}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected }}
          >
            {option.lead}
            <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  </View>
);

/**
 * A choice with too many options to show inline (UX-LIST-01): one row with the current value; tapping it opens a
 * bottom sheet that holds every option and scrolls on its own. Picking an option closes the sheet.
 */
const PickerRow = <T extends string>({ title, description, options, value, onChange, testID }: ChoiceRowProps<T>) => {
  const sheet = usePickerSheet();
  const current = options.find((option) => option.value === value)?.label ?? "";
  return (
    <>
      <Pressable
        style={styles.row}
        onPress={sheet.open}
        android_ripple={RIPPLE}
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${current}`}
        testID={testID}
      >
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{title}</Text>
          {description ? <Text style={styles.rowDescription}>{description}</Text> : null}
        </View>
        <Text style={styles.rowValue} numberOfLines={1}>
          {current}
        </Text>
        <ChevronRight size={18} color={theme.colors.textDim} />
      </Pressable>
      <BottomSheet sheet={sheet} testID={testID ? `${testID}-sheet` : undefined}>
        <Text style={styles.sheetTitle}>{title}</Text>
        <MobileSheetScrollView accessibilityRole="radiogroup" showsVerticalScrollIndicator>
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <Pressable
                key={option.value}
                style={styles.optionRow}
                onPress={() => sheet.close(() => onChange(option.value))}
                android_ripple={RIPPLE}
                accessibilityRole="radio"
                accessibilityLabel={option.label}
                accessibilityState={{ selected }}
              >
                {option.lead}
                <Text style={[styles.optionLabel, selected && styles.chipLabelSelected]}>{option.label}</Text>
                {selected ? <Check size={18} color={theme.colors.accent} /> : null}
              </Pressable>
            );
          })}
        </MobileSheetScrollView>
      </BottomSheet>
    </>
  );
};

type MultiPickerRowProps = {
  title: string;
  options: readonly { value: string; label: string }[];
  values: readonly string[];
  onToggle: (value: string) => void;
  /** Row value when nothing is picked (e.g. "All genres"). */
  noneLabel: string;
  /**
   * Pinned in the sheet above the list, e.g. a search field. The sheet then keeps its full height whatever the number
   * of options, so the header stays above the keyboard while the list scrolls under it.
   */
  header?: React.ReactNode;
  /** Shown in the sheet instead of the list when there is no option (still loading, no match). */
  emptyText?: string;
  testID?: string;
};

/**
 * Multiple choice over a list that depends on the user's data (UX-LIST-01): one row with the current selection;
 * tapping it opens a bottom sheet holding every option (checkboxes) that scrolls on its own. The sheet stays open
 * while the user ticks options.
 */
export const MultiPickerRow = ({ title, options, values, onToggle, noneLabel, header, emptyText, testID }: MultiPickerRowProps) => {
  const sheet = usePickerSheet();
  const summary = values.map((value) => options.find((option) => option.value === value)?.label ?? value).join(", ") || noneLabel;
  return (
    <>
      <Pressable
        style={styles.row}
        onPress={sheet.open}
        android_ripple={RIPPLE}
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${summary}`}
        testID={testID}
      >
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{title}</Text>
        </View>
        <Text style={styles.rowValue} numberOfLines={1}>
          {summary}
        </Text>
        <ChevronRight size={18} color={theme.colors.textDim} />
      </Pressable>
      <BottomSheet sheet={sheet} testID={testID ? `${testID}-sheet` : undefined} fullHeight={header !== undefined}>
        <Text style={styles.sheetTitle}>{title}</Text>
        {header}
        {options.length === 0 && emptyText ? (
          <Text style={styles.sheetHint}>{emptyText}</Text>
        ) : (
          <MobileSheetScrollView showsVerticalScrollIndicator keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
            {options.map((option) => {
              const selected = values.includes(option.value);
              return (
                <Pressable
                  key={option.value}
                  style={styles.optionRow}
                  onPress={() => onToggle(option.value)}
                  android_ripple={RIPPLE}
                  accessibilityRole="checkbox"
                  accessibilityLabel={option.label}
                  accessibilityState={{ checked: selected }}
                >
                  <Text style={[styles.optionLabel, selected && styles.chipLabelSelected]}>{option.label}</Text>
                  {selected ? <Check size={18} color={theme.colors.accent} /> : null}
                </Pressable>
              );
            })}
          </MobileSheetScrollView>
        )}
      </BottomSheet>
    </>
  );
};

type LinkRowProps = {
  title: string;
  description?: string;
  onPress: () => void;
  danger?: boolean;
  chevron?: boolean;
  testID?: string;
};

export const LinkRow = memo(({ title, description, onPress, danger, chevron = true, testID }: LinkRowProps) => (
  <Pressable
    style={styles.row}
    onPress={onPress}
    android_ripple={RIPPLE}
    accessibilityRole="button"
    accessibilityLabel={title}
    testID={testID}
  >
    <View style={styles.rowText}>
      <Text style={[styles.rowTitle, danger && { color: theme.colors.danger }]}>{title}</Text>
      {description ? <Text style={styles.rowDescription}>{description}</Text> : null}
    </View>
    {chevron ? <ChevronRight size={18} color={theme.colors.textDim} /> : null}
  </Pressable>
));
LinkRow.displayName = "LinkRow";

export const Divider = () => <View style={styles.divider} />;

const styles = StyleSheet.create({
  group: { gap: 8 },
  groupTitle: {
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 1.6,
    textTransform: "uppercase",
    color: theme.colors.textDim,
    paddingHorizontal: 4,
  },
  card: panelCardStyle,
  row: {
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15, fontWeight: "600", color: theme.colors.text },
  rowDescription: { fontSize: 12, lineHeight: 16, color: theme.colors.textMuted },
  rowValue: { maxWidth: "40%", fontSize: 14, fontWeight: "600", color: theme.colors.accent },
  sheetTitle: { fontSize: 17, fontWeight: "800", color: theme.colors.text, paddingHorizontal: 4 },
  sheetHint: { fontSize: 13, color: theme.colors.textMuted, paddingHorizontal: 4, paddingVertical: 12 },
  optionRow: {
    minHeight: 52,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    borderRadius: 12,
    overflow: "hidden",
  },
  optionLabel: { flex: 1, fontSize: 15, fontWeight: "600", color: theme.colors.text },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border, marginLeft: 16 },
  choiceWrap: { paddingHorizontal: 16, paddingVertical: 12, gap: 6 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  chip: {
    minHeight: 48,
    minWidth: 64,
    paddingHorizontal: 14,
    borderRadius: 14,
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surfaceRaised,
    borderWidth: 1,
    borderColor: "transparent",
    overflow: "hidden",
  },
  chipSelected: { backgroundColor: theme.colors.accentSoft, borderColor: theme.colors.accent },
  chipLabel: { fontSize: 14, fontWeight: "600", color: theme.colors.textMuted },
  chipLabelSelected: { color: theme.colors.accent },
});
