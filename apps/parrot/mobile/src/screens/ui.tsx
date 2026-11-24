// Small text and layout helpers the screens share. Buttons, icon buttons and skeletons come from
// @space/mobile-shell/components (REL-FAM-03).
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, spacing } from "../theme";

export const Title = ({ children }: { children: React.ReactNode }) => <Text style={styles.title}>{children}</Text>;

export const Body = ({ children, muted }: { children: React.ReactNode; muted?: boolean }) => (
  <Text style={[styles.body, muted && { color: colors.textMuted }]}>{children}</Text>
);

export const ErrorText = ({ children }: { children: React.ReactNode }) => (
  <Text style={styles.error} accessibilityRole="alert">
    {children}
  </Text>
);

export const Centered = ({ children }: { children: React.ReactNode }) => <View style={styles.centered}>{children}</View>;

/** A row of round chips, one of them chosen (the library's Albums / Artists / Songs). */
export const Chips = <T extends string>({ options, value, onChange }: { options: ReadonlyArray<{ id: T; label: string }>; value: T; onChange: (id: T) => void }) => (
  <View style={styles.chips} accessibilityRole="tablist">
    {options.map((option) => {
      const active = option.id === value;
      return (
        <Pressable
          key={option.id}
          testID={`chip-${option.id}`}
          accessibilityRole="tab"
          accessibilityLabel={option.label}
          accessibilityState={{ selected: active }}
          hitSlop={6}
          onPress={() => onChange(option.id)}
          style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && { opacity: 0.7 }]}
        >
          <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
        </Pressable>
      );
    })}
  </View>
);

/** A page's big title over the sky, with its icon buttons on the right: the playlist page. Tab pages have none (PAR-NAV-04). */
export const PageTitle = ({ title, actions }: { title: string; actions?: React.ReactNode }) => (
  <View style={styles.pageTitleRow}>
    <Text style={styles.pageTitle} accessibilityRole="header" numberOfLines={1}>
      {title}
    </Text>
    {actions ? <View style={styles.pageActions}>{actions}</View> : null}
  </View>
);

const styles = StyleSheet.create({
  // The page's list already pads its sides: the title starts on the content's left edge, and the last action's icon
  // centres on the song rows' "…" column (row padding 8, "…" box 32 pulled 4 right, so its centre sits 20 in; a 48 dp
  // MobileIconButton centres 24 in, hence the 4 pull).
  pageTitleRow: { flexDirection: "row", alignItems: "center", paddingTop: spacing.md, paddingBottom: spacing.md },
  pageTitle: { flex: 1, color: colors.text, fontSize: 32, fontWeight: "800", letterSpacing: -0.5 },
  pageActions: { flexDirection: "row", gap: spacing.xs, marginRight: -4 },
  title: { color: colors.text, fontSize: 24, fontWeight: "700" },
  body: { color: colors.text, fontSize: 15, lineHeight: 21 },
  error: { color: colors.danger, fontSize: 14 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.md, padding: spacing.xl },
  chips: { flexDirection: "row", gap: spacing.sm },
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingVertical: 7,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { color: colors.text, fontSize: 14, fontWeight: "600" },
  chipTextActive: { color: colors.accentText },
});
