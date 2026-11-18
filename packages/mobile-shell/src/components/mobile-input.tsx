import React, { useState } from "react";
import { Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { useMobileShellTheme } from "../theme";
import { TV_FOCUS_RING_WIDTH } from "./tv-focus";

type MobileInputProps = {
  label?: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  secureTextEntry?: boolean;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
};

export const MobileInput = ({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry,
  autoCapitalize = "none",
}: MobileInputProps) => {
  const theme = useMobileShellTheme();
  const tv = Platform.isTV === true;
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.wrap}>
      {label ? (
        <Text style={[styles.label, { color: theme.colors.textMuted }]}>{label}</Text>
      ) : null}
      <TextInput
        style={[
          styles.input,
          {
            borderColor: theme.colors.controlBorder,
            color: theme.colors.text,
            backgroundColor: theme.colors.surfaceRaised,
          },
          // TV: the remote's ring in the accent colour, as on the sign-in fields (UX-TV-17).
          tv && { borderWidth: TV_FOCUS_RING_WIDTH },
          tv && focused && { borderColor: theme.colors.accent },
        ]}
        onFocus={tv ? () => setFocused(true) : undefined}
        onBlur={tv ? () => setFocused(false) : undefined}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.textMuted}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        spellCheck={false}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    gap: 6,
  },
  label: {
    fontSize: 14,
  },
  input: {
    borderWidth: 1,
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
  },
});
