import React from "react";
import { Image, Pressable, StyleSheet, Text, View, type ImageSourcePropType } from "react-native";
import { Headphones, Monitor, MonitorSmartphone, MousePointerClick, Sparkles, Tv } from "lucide-react-native";
import { useMobileShellTheme } from "../theme";

export type MobileEmptyLibraryStep = { title: string; body: string };

export type MobileEmptyLibraryProps = {
  /** The app's mascot, standing freely: no tile, no backdrop behind it. */
  mascotSource: ImageSourcePropType;
  eyebrow: string;
  title: string;
  /** One short line on where the titles or songs come from: the computer app. */
  subtitle: string;
  /** The hand-off to the computer: `MobileEmptyLibraryAction` on a phone, the TV's own focusable buttons on a TV. */
  actions: React.ReactNode;
  /** The three steps under the card, in order: pick on the computer, the app finds the details, watch or listen anywhere. */
  steps: [MobileEmptyLibraryStep, MobileEmptyLibraryStep, MobileEmptyLibraryStep];
  /** What the library holds: the last step's icon is a screen for films and series, headphones for music. */
  kind?: "video" | "music";
  /** "phone": the card on top of three stacked steps; "tv": the computer's layout straight on the sky (no card), the three steps side by side. */
  layout?: "phone" | "tv";
  /** Size scale (the TV passes its screen scale, UX-TV-13). */
  scale?: number;
  /** Drawn in the mascot's place when set (the TV's QR code to the downloads page). */
  aside?: React.ReactNode;
};

/**
 * The empty library of the phones and the TV (UX-EMPTY-01, PAR-EMPTY-01): the computer apps' screen (`EmptyLibrary` in
 * `@space/ui`) drawn with React Native. The freestanding mascot in a small box beside "Your library", "Add your first
 * …" and one line, the hand-off to the computer, then the three steps. Badger and Parrot share it, so only the accent
 * (the theme's) and the words differ. On the TV (UX-TV-18) the mascot and the text stand on the sky without the phone's
 * card, and the steps are cards whose icons name the computer, the details and this TV.
 */
export const MobileEmptyLibrary = ({ mascotSource, eyebrow, title, subtitle, actions, steps, kind = "video", layout = "phone", scale = 1, aside }: MobileEmptyLibraryProps) => {
  const theme = useMobileShellTheme();
  const s = (value: number) => Math.round(value * scale * 10) / 10;
  const tv = layout === "tv";
  const size = tv ? TV : PHONE;
  const stepIcons = tv ? [Monitor, Sparkles, kind === "music" ? Headphones : Tv] : [MousePointerClick, Sparkles, kind === "music" ? Headphones : MonitorSmartphone];
  const panel = {
    borderRadius: s(size.radius),
    borderWidth: 1,
    borderColor: `${theme.colors.border}${tv ? "99" : "8c"}`,
    backgroundColor: `${theme.colors.surface}${tv ? "c7" : "eb"}`,
  };
  const iconTint = tv ? { borderWidth: 1, borderColor: `${theme.colors.accent}40`, backgroundColor: `${theme.colors.accent}1f` } : { backgroundColor: theme.colors.accentSoft };
  const text = (
    <View style={styles.textColumn}>
      <Text style={[styles.eyebrow, { color: theme.colors.accent, fontSize: s(size.eyebrow), letterSpacing: s(size.eyebrowSpacing) }]}>{eyebrow.toUpperCase()}</Text>
      <Text
        style={[styles.title, { color: theme.colors.text, fontFamily: theme.font.family.display, fontSize: s(size.title), lineHeight: s(size.title * 1.15), marginTop: s(6) }]}
        accessibilityRole="header"
      >
        {title}
      </Text>
      <Text style={{ color: theme.colors.textMuted, fontSize: s(size.subtitle), lineHeight: s(size.subtitle * 1.45), marginTop: s(8) }}>{subtitle}</Text>
      {tv ? <View style={[styles.actions, { gap: s(11), marginTop: s(20) }]}>{actions}</View> : null}
    </View>
  );
  return (
    <View style={{ gap: s(size.gap) }} testID="empty-library">
      <View style={tv ? { paddingHorizontal: s(12), paddingVertical: s(20) } : [panel, { padding: s(size.cardPadding) }]} testID="empty-library-card">
        <View style={[styles.row, { gap: s(size.rowGap) }]}>
          <View style={[styles.mascotBox, { width: s(size.mascotBox[0]), height: s(size.mascotBox[1]) }]}>
            {aside ?? (
              <Image
                source={mascotSource}
                style={{ width: s(size.mascot), height: s(size.mascot) }}
                resizeMode="contain"
                accessible={false}
                accessibilityIgnoresInvertColors
                testID="empty-library-mascot"
              />
            )}
          </View>
          {text}
        </View>
        {tv ? null : <View style={[styles.actions, { gap: s(10), marginTop: s(16) }]}>{actions}</View>}
      </View>
      <View style={[tv ? styles.stepsRow : styles.stepsColumn, { gap: s(size.stepGap) }]} testID="empty-library-steps">
        {steps.map((step, index) => {
          const Icon = stepIcons[index]!;
          return (
            <View
              key={step.title}
              style={[panel, styles.step, tv && styles.stepTv, { gap: s(size.stepInnerGap), paddingHorizontal: s(size.stepPadding[0]), paddingVertical: s(size.stepPadding[1]) }]}
              testID={`empty-library-step-${index + 1}`}
            >
              <View style={[styles.stepIcon, iconTint, { width: s(size.stepIcon), height: s(size.stepIcon), borderRadius: s(size.stepIconRadius) }]}>
                <Icon size={s(size.stepIcon / 2)} color={theme.colors.accent} />
              </View>
              <View style={styles.stepText}>
                <Text style={{ color: theme.colors.text, fontSize: s(size.stepTitle), fontWeight: "700" }}>{`${index + 1}. ${step.title}`}</Text>
                <Text style={{ color: theme.colors.textMuted, fontSize: s(size.stepBody), lineHeight: s(size.stepBodyLine), marginTop: s(4) }}>{step.body}</Text>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
};

/** The phone's hand-off button: the accent pill of the computer apps' "Add media" / "Add music". */
export const MobileEmptyLibraryAction = ({ label, onPress, icon }: { label: string; onPress: () => void; icon?: React.ReactNode }) => {
  const theme = useMobileShellTheme();
  return (
    <Pressable
      testID="empty-library-action"
      style={[styles.button, { backgroundColor: theme.colors.accent }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {icon ?? null}
      <Text style={[styles.buttonLabel, { color: theme.accentTextHex }]}>{label}</Text>
    </Pressable>
  );
};

/**
 * Sizes. The TV's are the v2 TV mockup's 1920 px halved (one TV unit is two pixels, UX-TV-13); the phone keeps the
 * computer's (`@space/ui` `EmptyLibrary`) shrunk to its width.
 */
const TV = {
  gap: 17,
  radius: 10,
  cardPadding: 0,
  rowGap: 32,
  mascotBox: [150, 170],
  mascot: 150,
  eyebrow: 8.5,
  eyebrowSpacing: 1.4,
  title: 40,
  subtitle: 13.5,
  stepGap: 14,
  stepInnerGap: 11,
  stepPadding: [16, 16],
  stepIcon: 30,
  stepIconRadius: 8,
  stepTitle: 13,
  stepBody: 10.5,
  stepBodyLine: 15.2,
} as const;
const PHONE = {
  gap: 14,
  radius: 14,
  cardPadding: 18,
  rowGap: 14,
  mascotBox: [96, 144],
  mascot: 100,
  eyebrow: 11,
  eyebrowSpacing: 1.6,
  title: 26,
  subtitle: 14,
  stepGap: 12,
  stepInnerGap: 14,
  stepPadding: [16, 14],
  stepIcon: 38,
  stepIconRadius: 10,
  stepTitle: 15,
  stepBody: 13.5,
  stepBodyLine: 19,
} as const;

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center" },
  mascotBox: { alignItems: "center", justifyContent: "center", flexShrink: 0 },
  textColumn: { flex: 1, minWidth: 0 },
  eyebrow: { fontWeight: "900" },
  title: { fontWeight: "600" },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
  stepsRow: { flexDirection: "row" },
  stepsColumn: { flexDirection: "column" },
  step: { flexDirection: "row", alignItems: "flex-start" },
  stepTv: { flex: 1 },
  stepIcon: { alignItems: "center", justifyContent: "center" },
  stepText: { flex: 1, minWidth: 0 },
  button: { height: 44, borderRadius: 999, paddingHorizontal: 20, flexDirection: "row", alignItems: "center", gap: 8 },
  buttonLabel: { fontSize: 15, fontWeight: "700" },
});
