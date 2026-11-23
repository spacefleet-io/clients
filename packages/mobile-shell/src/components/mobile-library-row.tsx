/**
 * The phone's library header and its Filter / Sort sheets, shared by Badger and Parrot: the desktop row of PAR-LIB-06 /
 * UX-LIB-01 (switch, quiet counts, Filter and Sort; Filter opens chip sections with a search and a "+N more" chip on a
 * long list) brought to a phone screen (UX-LIB-05). One row holds the switch, then a Filter icon button carrying the
 * count of filters on in a badge, then a Sort icon button; the counts sit on a quiet line under it, with Clear while
 * filters are on.
 */
import React, { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { ArrowDownUp, ListFilter } from "lucide-react-native";
import { foldSearchText } from "@space/shared/fuzzySearch";
import { useMobileShellTheme } from "../theme";
import { MobileBottomSheet, MobileSheetScrollView } from "./mobile-bottom-sheet";

// --- Row pieces ------------------------------------------------------------------------------------------------------

/** One number of the quiet counts and its words ("14 albums", "12 of 21 movies"): the number is drawn in the text colour. */
export type MobileLibraryCount = { n: number; text: string };

/** "14 albums · 153 songs · 2 artists", quiet, each number in the text colour. */
export const MobileLibraryCounts = ({ counts }: { counts: readonly MobileLibraryCount[] }) => {
  const theme = useMobileShellTheme();
  return (
    <Text
      style={[styles.counts, { color: theme.colors.textMuted }]}
      numberOfLines={1}
      testID="library-counts"
    >
      {counts.map((count, i) => {
        const n = String(count.n);
        const at = count.text.indexOf(n);
        return (
          <Text key={i}>
            {i > 0 ? <Text style={styles.countsDot}>{"  ·  "}</Text> : null}
            {at < 0 ? (
              count.text
            ) : (
              <>
                {count.text.slice(0, at)}
                <Text style={[styles.countsNumber, { color: theme.colors.text }]}>{n}</Text>
                {count.text.slice(at + n.length)}
              </>
            )}
          </Text>
        );
      })}
    </Text>
  );
};

export type MobileLibrarySegmentOption<T extends string> = { id: T; label: string; icon?: ReactNode; testID?: string };

/** The tab switch: Movies / TV shows, Albums / Artists / Songs; the picked tab filled in the accent. */
export function MobileLibrarySegmented<T extends string>({
  options,
  value,
  onChange,
  testID = "library-tabs",
}: {
  options: ReadonlyArray<MobileLibrarySegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  testID?: string;
}) {
  const theme = useMobileShellTheme();
  return (
    <View
      style={[styles.segmented, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}
      accessibilityRole="tablist"
      testID={testID}
    >
      {options.map((option) => {
        const on = option.id === value;
        return (
          <Pressable
            key={option.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={option.label}
            hitSlop={{ top: 4, bottom: 4 }}
            onPress={() => onChange(option.id)}
            style={({ pressed }) => [styles.segment, on && { backgroundColor: theme.colors.accent }, pressed && !on && styles.pressed]}
            testID={option.testID}
          >
            {option.icon}
            <Text numberOfLines={1} style={[styles.segmentLabel, { color: on ? theme.accentTextHex : theme.colors.textMuted }]}>
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The row's icon button (Filter, Sort): a 42 dp square, filled in the accent while filters are on, the number of them in a badge on its corner. */
export const MobileLibraryRowButton = ({
  icon: Icon,
  accessibilityLabel,
  count = 0,
  active = false,
  disabled = false,
  onPress,
  testID,
}: {
  icon: typeof ListFilter;
  accessibilityLabel: string;
  count?: number;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
  testID?: string;
}) => {
  const theme = useMobileShellTheme();
  const fg = active ? theme.accentTextHex : theme.colors.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.iconButton,
        { borderColor: active ? theme.colors.accent : theme.colors.border, backgroundColor: active ? theme.colors.accent : theme.colors.surface },
        disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Icon size={17} color={fg} />
      {count > 0 ? (
        <View style={[styles.badge, { backgroundColor: theme.colors.text, borderColor: theme.colors.bg }]} accessible={false} testID={testID ? `${testID}-badge` : undefined}>
          <Text style={[styles.badgeLabel, { color: theme.colors.bg }]} maxFontSizeMultiplier={1.5}>
            {count}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
};

/** The quiet link that drops every filter. */
export const MobileLibraryClearLink = ({ label, onPress }: { label: string; onPress: () => void }) => {
  const theme = useMobileShellTheme();
  return (
    <Pressable accessibilityRole="button" hitSlop={10} onPress={onPress} testID="library-filter-clear" style={({ pressed }) => pressed && styles.pressed}>
      <Text style={[styles.clear, { color: theme.colors.textMuted }]}>{label}</Text>
    </Pressable>
  );
};

export type MobileLibraryHeaderLabels = {
  filter: string;
  sort: string;
  clear: string;
  /** The Filter button's accessibility label with filters on ("Filter, 2 on"). */
  filterActive: (count: number) => string;
};

/** The header over the library list: one row with the app's switch, Filter (count badge) and Sort; the counts under it. */
export const MobileLibraryHeader = ({
  switcher,
  counts,
  filterCount,
  filterDisabled = false,
  onOpenFilter,
  onOpenSort,
  onClear,
  labels,
}: {
  switcher: ReactNode;
  counts: readonly MobileLibraryCount[];
  filterCount: number;
  filterDisabled?: boolean;
  onOpenFilter: () => void;
  onOpenSort: () => void;
  onClear: () => void;
  labels: MobileLibraryHeaderLabels;
}) => {
  const active = filterCount > 0;
  return (
    <View style={styles.header} testID="library-header">
      <View style={styles.line}>
        <View style={styles.grow}>{switcher}</View>
        <MobileLibraryRowButton
          icon={ListFilter}
          accessibilityLabel={active ? labels.filterActive(filterCount) : labels.filter}
          count={filterCount}
          active={active}
          disabled={filterDisabled}
          onPress={onOpenFilter}
          testID="library-filter-button"
        />
        <MobileLibraryRowButton icon={ArrowDownUp} accessibilityLabel={labels.sort} onPress={onOpenSort} testID="library-sort-button" />
      </View>
      <View style={styles.countsLine}>
        <View style={styles.grow}>
          <MobileLibraryCounts counts={counts} />
        </View>
        {active ? <MobileLibraryClearLink label={labels.clear} onPress={onClear} /> : null}
      </View>
    </View>
  );
};

// --- The sheets ------------------------------------------------------------------------------------------------------

/**
 * A Filter / Sort sheet: its title, a body that scrolls as one (no list scrolls on its own) and its buttons. While more
 * of the body sits below, a fade over its bottom and a line over the buttons say so.
 */
export const MobileLibrarySheet = ({
  visible,
  onClose,
  title,
  footer,
  children,
  testID,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  footer: ReactNode;
  children: ReactNode;
  testID?: string;
}) => {
  const theme = useMobileShellTheme();
  const [frame, setFrame] = useState(0);
  const [content, setContent] = useState(0);
  const [offset, setOffset] = useState(0);
  const moreBelow = content - frame - offset > 4;
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => setOffset(event.nativeEvent.contentOffset.y), []);
  return (
    <MobileBottomSheet visible={visible} onClose={onClose} title={title} testID={testID}>
      <View style={styles.sheetBody}>
        <MobileSheetScrollView
          contentContainerStyle={styles.sheetContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onLayout={(event: LayoutChangeEvent) => setFrame(event.nativeEvent.layout.height)}
          onContentSizeChange={(_, height) => setContent(height)}
          onScroll={onScroll}
          testID={testID ? `${testID}-body` : undefined}
        >
          {children}
        </MobileSheetScrollView>
        {moreBelow ? (
          <View pointerEvents="none" style={styles.fade} testID={testID ? `${testID}-fade` : undefined}>
            <Svg width="100%" height="100%">
              <Defs>
                <LinearGradient id="library-sheet-fade" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={theme.colors.surfaceRaised} stopOpacity={0} />
                  <Stop offset="1" stopColor={theme.colors.surfaceRaised} stopOpacity={1} />
                </LinearGradient>
              </Defs>
              <Rect x="0" y="0" width="100%" height="100%" fill="url(#library-sheet-fade)" />
            </Svg>
          </View>
        ) : null}
      </View>
      <View style={[styles.sheetFooter, { borderTopColor: moreBelow ? theme.colors.border : "transparent" }]}>{footer}</View>
    </MobileBottomSheet>
  );
};

/** One labelled group of a sheet (Genres, Decade, Sort by). */
export const MobileLibrarySheetSection = ({ label, children, testID }: { label: string; children: ReactNode; testID?: string }) => {
  const theme = useMobileShellTheme();
  return (
    <View style={styles.section} testID={testID}>
      <Text accessibilityRole="header" style={[styles.sectionLabel, { color: theme.colors.textMuted }]}>
        {label.toUpperCase()}
      </Text>
      {children}
    </View>
  );
};

type SheetButton = { label: string; onPress: () => void; testID?: string };

/** The sheet's quiet secondary button (Reset) and its filled primary one (Apply, Done). */
export const MobileLibrarySheetButtons = ({ secondary, primary }: { secondary?: SheetButton; primary: SheetButton }) => {
  const theme = useMobileShellTheme();
  return (
    <View style={styles.sheetButtons}>
      {secondary ? (
        <Pressable accessibilityRole="button" onPress={secondary.onPress} testID={secondary.testID} style={({ pressed }) => [styles.sheetButton, pressed && styles.pressed]}>
          <Text style={[styles.sheetButtonLabel, { color: theme.colors.text }]}>{secondary.label}</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={primary.onPress}
        testID={primary.testID}
        style={({ pressed }) => [styles.sheetButton, styles.sheetPrimary, { backgroundColor: theme.colors.accent }, pressed && styles.pressed]}
      >
        <Text style={[styles.sheetButtonLabel, { color: theme.accentTextHex }]}>{primary.label}</Text>
      </Pressable>
    </View>
  );
};

/** A pill of a sheet; `on` marks a pick (filled in the accent), left out for an action pill ("+N more", a direction). */
export type MobileLibraryPill = { id: string; label: string; on?: boolean; onPress: () => void; testID?: string; icon?: ReactNode };

/** A wrap of pressable pills: the sorts, a list's choices, the on / off filters. */
export const MobileLibraryPills = ({ pills }: { pills: ReadonlyArray<MobileLibraryPill> }) => {
  const theme = useMobileShellTheme();
  return (
    <View style={styles.pills}>
      {pills.map((pill) => (
        <Pressable
          key={pill.id}
          accessibilityRole="button"
          accessibilityState={pill.on === undefined ? undefined : { selected: pill.on }}
          hitSlop={{ top: 4, bottom: 4 }}
          onPress={pill.onPress}
          testID={pill.testID}
          style={({ pressed }) => [
            styles.pill,
            pill.on
              ? { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent }
              : { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
            pressed && styles.pressed,
          ]}
        >
          {pill.icon}
          <Text numberOfLines={1} style={[styles.pillLabel, { color: pill.on ? theme.accentTextHex : theme.colors.text }]}>
            {pill.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
};

/** Up to this many choices a list is plain chips; past it (Actors, Directors in a big library) a search narrows them. */
export const MOBILE_FILTER_CHIP_LIMIT = 15;

export type MobileLibraryChoice = { value: string; label: string };

/**
 * One list of the Filter sheet, as the desktop panel's (UX-LIB-01): chips on while picked. A short list shows every
 * chip; a long one shows a search, its picks, the first MOBILE_FILTER_CHIP_LIMIT matches and a "+N more" chip that
 * shows the rest in place. `single` keeps at most one pick (Parrot's Genre and Decade).
 */
export const MobileLibraryFilterPicker = ({
  options,
  selected,
  onChange,
  searchPlaceholder,
  emptyText,
  moreLabel,
  single = false,
  testID,
}: {
  options: readonly MobileLibraryChoice[];
  selected: readonly string[];
  onChange: (next: string[]) => void;
  searchPlaceholder: string;
  emptyText: string;
  moreLabel: (count: number) => string;
  single?: boolean;
  testID?: string;
}) => {
  const theme = useMobileShellTheme();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const searchable = options.length > MOBILE_FILTER_CHIP_LIMIT;
  const pills = useMemo((): MobileLibraryPill[] => {
    const selectedSet = new Set(selected);
    const q = foldSearchText(query.trim());
    const picked = searchable ? options.filter((option) => selectedSet.has(option.value)) : [];
    const matches = searchable ? options.filter((option) => !selectedSet.has(option.value) && (!q || foldSearchText(option.label).includes(q))) : options;
    const visible = expanded ? matches : matches.slice(0, MOBILE_FILTER_CHIP_LIMIT);
    const hidden = matches.length - visible.length;
    const toggle = (value: string) =>
      onChange(selectedSet.has(value) ? selected.filter((entry) => entry !== value) : single ? [value] : [...selected, value]);
    const list: MobileLibraryPill[] = [...picked, ...visible].map((option) => ({
      id: option.value,
      label: option.label,
      on: selectedSet.has(option.value),
      onPress: () => toggle(option.value),
    }));
    if (hidden > 0)
      list.push({
        id: "__more",
        label: moreLabel(hidden),
        onPress: () => setExpanded(true),
        testID: "library-filter-more",
      });
    return list;
  }, [expanded, moreLabel, onChange, options, query, searchable, selected, single]);
  return (
    <View style={styles.picker} testID={testID}>
      {searchable ? (
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={searchPlaceholder}
          placeholderTextColor={theme.colors.textDim}
          accessibilityLabel={searchPlaceholder}
          autoCorrect={false}
          style={[styles.search, { color: theme.colors.text, backgroundColor: theme.colors.surface, borderColor: theme.colors.controlBorder }]}
          testID={testID ? `${testID}-search` : undefined}
        />
      ) : null}
      {pills.length === 0 ? <Text style={[styles.empty, { color: theme.colors.textMuted }]}>{emptyText}</Text> : <MobileLibraryPills pills={pills} />}
    </View>
  );
};

const styles = StyleSheet.create({
  header: { gap: 8 },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1, minWidth: 0 },
  countsLine: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 18, paddingHorizontal: 2 },
  counts: { fontSize: 13 },
  countsDot: { opacity: 0.5 },
  countsNumber: { fontWeight: "600" },
  segmented: { flexDirection: "row", padding: 3, gap: 3, borderRadius: 12, borderWidth: 1 },
  // Each tab starts from its label's width and takes an equal share of what is left (flexBasis auto, not flex: 1's equal
  // thirds): at a large font size a long label ("Albums" at 1.3) gets the room the shorter ones do not need.
  segment: { flexGrow: 1, flexShrink: 1, flexBasis: "auto", height: 34, borderRadius: 9, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 6 },
  segmentLabel: { fontSize: 13, fontWeight: "700" },
  iconButton: { width: 42, height: 42, borderRadius: 10, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  badge: { position: "absolute", top: -6, right: -6, minWidth: 19, minHeight: 19, borderRadius: 10, borderWidth: 2, paddingHorizontal: 4, alignItems: "center", justifyContent: "center" },
  badgeLabel: { fontSize: 11, fontWeight: "800" },
  clear: { fontSize: 13, fontWeight: "600" },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
  sheetBody: { flexShrink: 1, minHeight: 0 },
  sheetContent: { gap: 20, paddingBottom: 8, paddingTop: 2 },
  fade: { position: "absolute", left: 0, right: 0, bottom: 0, height: 44 },
  sheetFooter: { borderTopWidth: 1, paddingTop: 12 },
  sheetButtons: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 8 },
  sheetButton: { minHeight: 44, minWidth: 88, paddingHorizontal: 18, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  sheetPrimary: {},
  sheetButtonLabel: { fontSize: 15, fontWeight: "700" },
  section: { gap: 10 },
  sectionLabel: { fontSize: 11, fontWeight: "900", letterSpacing: 1.5 },
  pills: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pill: { height: 36, borderRadius: 10, borderWidth: 1, paddingHorizontal: 13, flexDirection: "row", alignItems: "center", gap: 6, maxWidth: "100%" },
  pillLabel: { fontSize: 14, fontWeight: "500", flexShrink: 1 },
  picker: { gap: 10 },
  search: { height: 44, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, fontSize: 15 },
  empty: { fontSize: 13 },
});
