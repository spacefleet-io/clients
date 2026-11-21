import React, { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Check } from "lucide-react-native";
import { useTranslation } from "../i18n";
import { scopeLogger } from "../logger";
import { ProfileAvatarImage, profileAvatarRadius } from "../profiles/ProfileAvatarImage";
import { PROFILE_AVATAR_IDS, type ProfileAvatarId } from "@space/shared/profileAvatars";
import { useTvScale, useTvStyles } from "./tvScale";
import type { TvViewInstance } from "./tvViewInstance";
import { TvFocusable } from "./TvFocusable";
import { hexAlpha, useTvAccent, type TvAccent } from "./tokens";

const log = scopeLogger("tv.avatar_grid");

/**
 * How long after the chosen avatar asks for the focus a focus landing elsewhere is UIKit's own focus update (the step
 * replacing the previous one, the keyboard closing), not the viewer's move.
 */
export const TV_AVATAR_FOCUS_SETTLE_MS = 1000;

/**
 * The two looks of the TV's avatar chooser:
 * - `compact`: Add and Edit profile (ACCT-PROF-05): two rows of 11 rounded tiles, the chosen one ringed in the accent
 *   with a tick, the focused one ringed in white.
 * - `setup`: "Your profile" (UX-SETUP-10, design `tv-step.png`): six columns of round avatars; the chosen one in an
 *   accent ring with a gap; the focused one grows with a soft accent glow (and a white ring when it is not the chosen one).
 */
export type TvAvatarGridVariant = "compact" | "setup";

/** Columns, cell and gap in design dp (960x540, scaled with the TV, UX-TV-13). Setup: the design's 82 px at 1280 wide. */
export const TV_AVATAR_GRID_LAYOUT: Record<TvAvatarGridVariant, { columns: number; cell: number; gap: number }> = {
  compact: { columns: 11, cell: 64, gap: 10 },
  setup: { columns: 6, cell: 61.5, gap: 16.5 },
};

/** Lift of the focused avatar in the setup grid (design `scale(1.12)`). */
export const TV_SETUP_AVATAR_FOCUS_SCALE = 1.12;

type TvAvatarGridProps = {
  value: ProfileAvatarId;
  onChange: (id: ProfileAvatarId) => void;
  /** The avatar the remote's focus just moved onto. */
  onFocusAvatar?: (id: ProfileAvatarId) => void;
  variant?: TvAvatarGridVariant;
  /**
   * Counts the requests to send the remote's focus to the chosen avatar: each new value is one (0: none). The setup step
   * asks once when it appears; Add and Edit profile ask at each name submit from the keyboard.
   */
  focusChosen?: number;
};

/**
 * The TV's avatar chooser (ACCT-PROF-05): the 22 avatars in pack order, every cell a remote focus target that the
 * arrows walk and OK picks. One grid for Add/Edit profile and the "Your profile" setup step (UX-SETUP-10).
 *
 * On tvOS UIKit runs its own focus update right after a request (the step replacing the previous one, the keyboard
 * closing) and lands on the first avatar or the name field (seen on the Apple TV simulator 2026-11-18, as
 * TV-SHELL-FOCUS-002 on Home). So within TV_AVATAR_FOCUS_SETTLE_MS of a request a focus landing on another avatar goes
 * back to the chosen one, once, and when that time is up the chosen one asks again if no avatar holds the focus.
 */
export const TvAvatarGrid = ({ value, onChange, onFocusAvatar, variant = "compact", focusChosen = 0 }: TvAvatarGridProps) => {
  const { t } = useTranslation();
  const scale = useTvScale();
  const accent = useTvAccent();
  const styles = useTvStyles(useMemo(() => (variant === "setup" ? setupStyles : compactStyles)(accent), [variant, accent]));
  const { columns, cell, gap } = TV_AVATAR_GRID_LAYOUT[variant];
  const [focused, setFocused] = useState<ProfileAvatarId | null>(null);
  const focusedRef = useRef<ProfileAvatarId | null>(null);
  const chosenRef = useRef<TvViewInstance>(null);
  // When the last request was made, until its one correction is spent.
  const requestedAt = useRef<number | null>(null);
  useEffect(() => {
    if (focusChosen === 0) return undefined;
    requestedAt.current = Date.now();
    log.info("focus.request", { request: focusChosen });
    chosenRef.current?.requestTVFocus();
    const settle = setTimeout(() => {
      if (focusedRef.current !== null) return;
      log.info("focus.settle", {});
      chosenRef.current?.requestTVFocus();
    }, TV_AVATAR_FOCUS_SETTLE_MS);
    return () => clearTimeout(settle);
  }, [focusChosen]);
  /** A focus on another avatar within the settle time of a request is UIKit's: the chosen one takes it back, once. */
  const retake = (landed: ProfileAvatarId) => {
    const at = requestedAt.current;
    if (at === null) return;
    requestedAt.current = null;
    const sinceMs = Date.now() - at;
    if (sinceMs > TV_AVATAR_FOCUS_SETTLE_MS) return;
    log.info("focus.retake", { landed, sinceMs });
    chosenRef.current?.requestTVFocus();
  };
  const onCellFocus = (id: ProfileAvatarId) => {
    focusedRef.current = id;
    setFocused(id);
    onFocusAvatar?.(id);
    if (id !== value) retake(id);
  };
  const onCellBlur = (id: ProfileAvatarId) => {
    if (focusedRef.current !== id) return;
    focusedRef.current = null;
    setFocused(null);
  };
  const imageSize = (variant === "setup" ? cell : cell - 10) * scale;
  return (
    <View testID="avatar-chooser" style={[styles.grid, { width: (columns * cell + (columns - 1) * gap) * scale, gap: gap * scale }]}>
      {PROFILE_AVATAR_IDS.map((id) => {
        const selected = id === value;
        const isFocused = focused === id;
        return (
          <TvFocusable
            key={id}
            ref={selected ? chosenRef : undefined}
            testID={`avatar-option-${id}`}
            ring="none"
            scale={variant === "setup" ? TV_SETUP_AVATAR_FOCUS_SCALE : 1}
            hasTVPreferredFocus={focusChosen > 0 && selected}
            accessibilityRole="radio"
            accessibilityState={{ selected, checked: selected }}
            accessibilityLabel={t(`profiles.avatars.${id}`)}
            onFocus={() => onCellFocus(id)}
            onBlur={() => onCellBlur(id)}
            onPress={() => onChange(id)}
            style={[styles.cell, selected && styles.cellSelected, isFocused && styles.cellFocused, isFocused && selected && styles.cellFocusedSelected]}
          >
            <ProfileAvatarImage
              avatarId={id}
              size={imageSize}
              testID={`avatar-option-image-${id}`}
              style={variant === "setup" ? { borderRadius: imageSize / 2 } : undefined}
            />
            {selected && variant === "compact" ? (
              <View style={styles.tick} testID="avatar-option-tick">
                <Check size={14 * scale} strokeWidth={3.5} color={accent.onColor} />
              </View>
            ) : null}
          </TvFocusable>
        );
      })}
    </View>
  );
};

const COMPACT = TV_AVATAR_GRID_LAYOUT.compact.cell;
const SETUP = TV_AVATAR_GRID_LAYOUT.setup.cell;

const compactStyles = (accent: TvAccent) => StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center" },
  cell: {
    width: COMPACT,
    height: COMPACT,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: "transparent",
    borderRadius: profileAvatarRadius(COMPACT) + 3,
  },
  cellSelected: { borderColor: accent.color },
  cellFocused: { borderColor: "#ffffff" },
  cellFocusedSelected: {},
  tick: {
    position: "absolute",
    top: -7,
    right: -7,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: accent.color,
  },
});

/** Design `tv-step.html` at 1280 wide, times 0.75 for the 960 dp design screen. */
const setupStyles = (accent: TvAccent) => StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-start" },
  cell: {
    width: SETUP,
    height: SETUP,
    borderRadius: SETUP / 2,
    backgroundColor: "#2c2f45",
    alignItems: "center",
    justifyContent: "center",
  },
  // `outline: 4px solid <accent>; outline-offset: 3px` (an outline takes no room: nothing moves).
  cellSelected: { outlineWidth: 3, outlineStyle: "solid", outlineColor: accent.color, outlineOffset: 2.25 },
  // `box-shadow: 0 0 0 8px <accent at 25 %>` around the lifted avatar; white ring when it is not the chosen one.
  cellFocused: {
    boxShadow: `0px 0px 0px 6px ${hexAlpha(accent.color, 0.25)}`,
    outlineWidth: 3,
    outlineStyle: "solid",
    outlineColor: "#ffffff",
    outlineOffset: 2.25,
  },
  cellFocusedSelected: { outlineColor: accent.color },
  tick: {},
});
