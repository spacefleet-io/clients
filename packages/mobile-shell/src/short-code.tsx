// The pairing code on a phone or a TV (ACCT-PAIR-01, UX-PHONE-10): shown as two groups of 4 boxes with a gap between them,
// never a dash (Chris 2026-11-18), and typed in the same boxes. One field under the boxes takes the code typed or pasted
// with or without a dash or spaces, in any case, and each character lands in the next box on its own.
import React, { forwardRef, useState } from "react";
import { Platform, StyleSheet, Text, TextInput, View, useWindowDimensions, type StyleProp, type TextInputInstance, type ViewStyle } from "react-native";
import { SHORT_CODE_LENGTH, shortCodeGroups, shortCodeInput } from "@space/pairing-crypto";
import { useMobileShellTheme } from "./theme";

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";
/** Space between the boxes, and between the code and the page's edges. */
export const SHORT_CODE_PAGE_PADDING = 28;
const TILE_GAP = 6;
const GROUP_GAP = 14;

export type ShortCodeTileSize = { width: number; height: number; fontSize: number };

/**
 * The code's boxes: the mockup's 44x58 boxes, shrunk in the same proportions when `count` characters would not fit the
 * window's width between the page's margins.
 */
export const codeTileSize = (windowWidth: number, count: number): ShortCodeTileSize => {
  const gaps = (count - 2) * TILE_GAP + GROUP_GAP;
  const width = Math.min(44, Math.floor((windowWidth - 2 * SHORT_CODE_PAGE_PADDING - gaps) / count));
  return { width, height: Math.round((width * 58) / 44), fontSize: Math.round((width * 32) / 44) };
};

type TilesProps = {
  /** The code as the API sent it, or what is typed so far; anything but letters and digits is dropped. */
  code: string;
  testID?: string;
  /** The box the next character goes in, outlined in the accent (a code field with focus). */
  activeIndex?: number | null;
  size?: ShortCodeTileSize;
  style?: StyleProp<ViewStyle>;
};

/** 8 boxes in two groups of 4 with a gap; empty boxes for characters not there yet. Read out character by character. */
export const ShortCodeTiles = ({ code, testID, activeIndex = null, size, style }: TilesProps) => {
  const { colors } = useMobileShellTheme();
  const { width: windowWidth } = useWindowDimensions();
  const tile = size ?? codeTileSize(windowWidth, SHORT_CODE_LENGTH);
  const [first, second] = shortCodeGroups(code);
  const chars = (first + second).padEnd(SHORT_CODE_LENGTH, " ").split("");
  const half = SHORT_CODE_LENGTH / 2;
  return (
    <View style={[styles.code, style]} testID={testID} accessible accessibilityLabel={(first + second).split("").join(" ")}>
      {[chars.slice(0, half), chars.slice(half)].map((group, gi) => (
        <View key={gi} style={styles.group}>
          {group.map((char, ci) => {
            const index = gi * half + ci;
            const active = index === activeIndex;
            return (
              <View
                key={ci}
                style={[
                  styles.char,
                  {
                    width: tile.width,
                    height: tile.height,
                    backgroundColor: colors.surface,
                    borderColor: active ? colors.accent : colors.border,
                    borderWidth: active ? 2 : 1,
                  },
                ]}
              >
                <Text style={[styles.charText, { fontSize: tile.fontSize, color: colors.text }]}>{char.trim()}</Text>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
};

type InputProps = {
  /** The canonical code typed so far (0..8 characters, from `shortCodeInput`). */
  value: string;
  onChange: (code: string) => void;
  /** The keyboard's Enter / Done. */
  onSubmit?: () => void;
  testID?: string;
  accessibilityLabel?: string;
  autoFocus?: boolean;
  editable?: boolean;
  size?: ShortCodeTileSize;
  style?: StyleProp<ViewStyle>;
};

/**
 * The code field (ACCT-PAIR-01): the boxes, with one invisible field laid over them that holds the code. Typing fills
 * the next box, Backspace empties the last one, and a pasted "abcd-efgh", "ABCD EFGH" or pairing link fills them all.
 */
export const ShortCodeInput = forwardRef<TextInputInstance, InputProps>(function ShortCodeInput(
  { value, onChange, onSubmit, testID, accessibilityLabel, autoFocus, editable = true, size, style },
  ref,
) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.field, style]}>
      <ShortCodeTiles code={value} size={size} activeIndex={focused && value.length < SHORT_CODE_LENGTH ? value.length : null} />
      <TextInput
        ref={ref}
        testID={testID}
        value={value}
        onChangeText={(raw) => onChange(shortCodeInput(raw))}
        onSubmitEditing={onSubmit}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        accessibilityLabel={accessibilityLabel}
        autoFocus={autoFocus}
        editable={editable}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        // No suggestions bar on Android keyboards, which would otherwise keep the letters in a word.
        keyboardType={Platform.OS === "android" ? "visible-password" : "default"}
        caretHidden
        // The tiles draw the code: the field's own text, caret and selection stay invisible.
        selectionColor="transparent"
        focusable
        style={styles.overlay}
      />
    </View>
  );
});

const styles = StyleSheet.create({
  code: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: GROUP_GAP },
  group: { flexDirection: "row", gap: TILE_GAP },
  char: { borderRadius: 12, alignItems: "center", justifyContent: "center" },
  charText: { fontFamily: MONO, fontWeight: "700" },
  field: { alignSelf: "center" },
  // Covers the boxes so a tap or long press anywhere on them focuses the field or opens Paste; draws nothing (transparent
  // text and selection, no caret).
  overlay: { ...StyleSheet.absoluteFill, color: "transparent", backgroundColor: "transparent" },
});
