import React, { useCallback, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View, type TextInputInstance, type TextInputProps } from "react-native";
import Animated, { useSharedValue, useAnimatedStyle, withSpring } from "react-native-reanimated";
import { useMobileShellTheme } from "../theme";
import { TV_FOCUS_RING_WIDTH, TV_FOCUS_SCALE } from "./tv-focus";

type MobileAuthInputProps = {
  icon?: React.ComponentType<{ size?: number; color?: string }>;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  secureTextEntry?: boolean;
  keyboardType?: "default" | "email-address";
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  /** iOS content type: without it iOS guesses and may offer Strong Password autofill on a login field. */
  textContentType?: TextInputProps["textContentType"];
  autoComplete?: TextInputProps["autoComplete"];
  /** The caller's handle on the text input, to move the keyboard to it from the previous field (UX-TV-16, UX-PHONE-08). */
  inputRef?: React.RefObject<TextInputInstance | null>;
  /** Keyboard action key ("next" moves on, "done" submits) and what it does; the field keeps the keyboard on submit. */
  returnKeyType?: TextInputProps["returnKeyType"];
  onSubmitEditing?: () => void;
  /** Stable handle for the on-device harness (apps/badger/mobile/e2e-phone): set on the text input itself. */
  testID?: string;
};

export const MobileAuthInput = ({
  icon: Icon,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  keyboardType,
  autoCapitalize,
  textContentType,
  autoComplete,
  inputRef: callerRef,
  returnKeyType,
  onSubmitEditing,
  testID,
}: MobileAuthInputProps) => {
  const theme = useMobileShellTheme();
  const [focused, setFocused] = useState(false);
  const ownRef = useRef<TextInputInstance>(null);
  const inputRef = callerRef ?? ownRef;
  const tv = Platform.isTV === true;

  // iOS sizes a TextInput to its text line, so the field's padding and icon would not take taps on their own.
  // The wrapper never takes the keyboard focus: the focus lands on the text input itself, so the keyboard types into
  // the field that shows the focus. On the Google TV the wrapper took the remote's focus and the text went on into the
  // email field (UX-TV-16); on the phone Tab from the email parked the focus on the password's wrapper and the typed
  // keys were lost (UX-PHONE-08).
  return (
    <Pressable
      onPress={() => inputRef.current?.focus()}
      accessible={false}
      focusable={false}
      style={[
        styles.inputWrap,
        { borderColor: theme.colors.controlBorder },
        tv && { borderWidth: TV_FOCUS_RING_WIDTH },
        focused && {
          borderColor: theme.colors.accent,
          backgroundColor: "rgba(18,25,38,1)",
        },
      ]}
    >
      {Icon ? <Icon size={17} color={focused ? theme.colors.accent : theme.colors.textDim} /> : null}
      <TextInput
        ref={inputRef}
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textDim}
        style={[styles.input, { color: theme.colors.text }]}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize ?? "none"}
        autoCorrect={false}
        spellCheck={false}
        textContentType={textContentType}
        autoComplete={autoComplete}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing ? () => onSubmitEditing() : undefined}
        submitBehavior={onSubmitEditing ? "submit" : undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      />
    </Pressable>
  );
};

type MobileAuthButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  icon?: React.ReactNode;
  bgColor?: string;
  textColor?: string;
  testID?: string;
};

const PRESS_SPRING = { damping: 15, stiffness: 350, mass: 0.3 };

export const MobileAuthButton = ({ label, onPress, disabled, icon, bgColor, textColor, testID }: MobileAuthButtonProps) => {
  const theme = useMobileShellTheme();
  const scale = useSharedValue(1);
  const bg = bgColor ?? theme.colors.accent;
  const fg = textColor ?? theme.accentTextHex;
  const tv = Platform.isTV === true;
  const [focused, setFocused] = useState(false);
  const onPressIn = useCallback(() => {
    if (!disabled) scale.value = withSpring(0.97, PRESS_SPRING);
  }, [disabled, scale]);

  const onPressOut = useCallback(() => {
    scale.value = withSpring(1, PRESS_SPRING);
  }, [scale]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        style={[
          styles.enterButton,
          {
            backgroundColor: bg,
            shadowColor: bg,
          },
          // TV: the ring is the text colour (the button is already the accent colour), as on the TV's own buttons.
          tv && styles.tvRing,
          tv && focused && { borderColor: theme.colors.text, transform: [{ scale: TV_FOCUS_SCALE }] },
          disabled && { opacity: 0.5 },
        ]}
        onFocus={tv ? () => setFocused(true) : undefined}
        onBlur={tv ? () => setFocused(false) : undefined}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        onPress={onPress}
        testID={testID}
        disabled={disabled}
      >
        <Text style={[styles.enterButtonLabel, { color: fg }]}>{label}</Text>
        {icon}
      </Pressable>
    </Animated.View>
  );
};

type MobileAuthLinkProps = {
  label: string;
  onPress: () => void;
  color: string;
  style?: React.ComponentProps<typeof Text>["style"];
  testID?: string;
};

/** A text link under the form ("Forgot password?"). On TV it carries the remote's ring in the text colour (UX-TV-16). */
export const MobileAuthLink = ({ label, onPress, color, style, testID }: MobileAuthLinkProps) => {
  const theme = useMobileShellTheme();
  const tv = Platform.isTV === true;
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      style={[tv && styles.tvLinkRing, tv && focused && { borderColor: theme.colors.text }]}
      onFocus={tv ? () => setFocused(true) : undefined}
      onBlur={tv ? () => setFocused(false) : undefined}
      onPress={onPress}
      testID={testID}
    >
      <Text style={[style, { color: tv && focused ? theme.colors.text : color }]}>{label}</Text>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  inputWrap: {
    height: 56,
    borderRadius: 18,
    borderWidth: 1,
    backgroundColor: "rgba(18,25,38,0.9)",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    gap: 10,
  },
  tvRing: {
    borderWidth: TV_FOCUS_RING_WIDTH,
    borderColor: "transparent",
  },
  tvLinkRing: {
    borderWidth: TV_FOCUS_RING_WIDTH,
    borderColor: "transparent",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  input: {
    flex: 1,
    alignSelf: "stretch",
    fontWeight: "700",
    fontSize: 13,
    letterSpacing: 1,
  },
  enterButton: {
    marginTop: 4,
    height: 56,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 8,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 8,
  },
  enterButtonLabel: {
    fontWeight: "900",
    fontSize: 13,
    letterSpacing: 1.3,
  },
});
