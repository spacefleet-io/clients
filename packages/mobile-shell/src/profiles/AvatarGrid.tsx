import React, { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Check } from "lucide-react-native";
import { PROFILE_AVATAR_IDS, type ProfileAvatarId } from "@space/shared/profileAvatars";
import { useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";
import { ProfileAvatarImage, profileAvatarRadius } from "./ProfileAvatarImage";

/** The manager's columns (mockup `mockup-avatar-picker.png`: one flat grid of the 22, four across). */
export const AVATAR_CHOOSER_COLUMNS = 4;
const SQUARE_GAP = 16;
/**
 * "Your profile" (UX-SETUP-10, `phone-step.png`): round avatars 12 dp apart, five across, filling the card's content
 * width so the grid lines up with the text above it and the chosen one's ring stays inside the card. 50 dp until the
 * grid's width is known, never bigger than 56 dp.
 */
const ROUND_SIZE = 50;
const ROUND_SIZE_MAX = 56;
const ROUND_GAP = 12;
const RING_WIDTH = 4;
const RING_OFFSET = 3;

export type AvatarGridProps = {
  value: ProfileAvatarId;
  onChange: (id: ProfileAvatarId) => void;
  /**
   * `square` (the profiles manager): rounded squares filling the width, four across, the chosen one ringed with a
   * tick. `round` (the "Your profile" step and its standalone screen): round avatars filling the width, the chosen one in a 4 dp
   * ring of the app's colour, 3 dp away.
   */
  variant?: "square" | "round";
  columns?: number;
};

/**
 * The phones' one avatar grid (ACCT-PROF-05): the 22 avatars in pack order, the chosen one ringed in the app's colour.
 * Each cell reads as the avatar's name. The profiles manager and "Your profile" (UX-SETUP-10) both draw this one.
 */
export const AvatarGrid = ({ value, onChange, variant = "square", columns }: AvatarGridProps) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const [width, setWidth] = useState(0);
  if (variant === "round") {
    const across = columns ?? 5;
    const size = width > 0 ? Math.min(ROUND_SIZE_MAX, Math.floor((width - (across - 1) * ROUND_GAP) / across)) : ROUND_SIZE;
    const outer = size + RING_OUTSET * 2;
    return (
      <View
        testID="avatar-chooser"
        accessibilityRole="radiogroup"
        style={[styles.grid, styles.roundGrid]}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        {PROFILE_AVATAR_IDS.map((id) => {
          const selected = id === value;
          return (
            <Pressable
              key={id}
              testID={`avatar-option-${id}`}
              accessibilityRole="radio"
              accessibilityState={{ selected, checked: selected }}
              accessibilityLabel={t(`profiles.avatars.${id}`)}
              onPress={() => onChange(id)}
              hitSlop={ROUND_GAP / 2}
              style={{ width: size, height: size }}
            >
              <ProfileAvatarImage avatarId={id} size={size} style={[styles.round, { borderRadius: size / 2 }]} testID={`avatar-option-image-${id}`} />
              {selected ? (
                <View
                  pointerEvents="none"
                  testID="avatar-option-ring"
                  style={[styles.ring, { width: outer, height: outer, borderRadius: outer / 2, borderColor: theme.colors.accent }]}
                />
              ) : null}
            </Pressable>
          );
        })}
      </View>
    );
  }
  const across = columns ?? AVATAR_CHOOSER_COLUMNS;
  const cell = width > 0 ? Math.floor((width - SQUARE_GAP * (across - 1)) / across) : 0;
  return (
    <View
      testID="avatar-chooser"
      accessibilityRole="radiogroup"
      style={[styles.grid, styles.squareGrid]}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {cell > 0
        ? PROFILE_AVATAR_IDS.map((id) => {
            const selected = id === value;
            return (
              <Pressable
                key={id}
                testID={`avatar-option-${id}`}
                accessibilityRole="radio"
                accessibilityState={{ selected, checked: selected }}
                accessibilityLabel={t(`profiles.avatars.${id}`)}
                onPress={() => onChange(id)}
                style={[
                  styles.squareCell,
                  { width: cell, height: cell, borderRadius: profileAvatarRadius(cell) + 4 },
                  selected && { borderColor: theme.colors.accent },
                ]}
              >
                <ProfileAvatarImage avatarId={id} size={cell - 10} testID={`avatar-option-image-${id}`} />
                {selected ? (
                  <View style={[styles.tick, { backgroundColor: theme.colors.accent }]} testID="avatar-option-tick">
                    <Check size={16} strokeWidth={3.5} color={theme.accentTextHex} />
                  </View>
                ) : null}
              </Pressable>
            );
          })
        : null}
    </View>
  );
};

const RING_OUTSET = RING_WIDTH + RING_OFFSET;

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap" },
  squareGrid: { gap: SQUARE_GAP, marginTop: 8 },
  squareCell: { alignItems: "center", justifyContent: "center", borderWidth: 3, borderColor: "transparent" },
  tick: {
    position: "absolute",
    top: -8,
    right: -8,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  roundGrid: { gap: ROUND_GAP, alignSelf: "stretch" },
  round: { backgroundColor: "#2c2f45" },
  ring: { position: "absolute", top: -RING_OUTSET, left: -RING_OUTSET, borderWidth: RING_WIDTH },
});
