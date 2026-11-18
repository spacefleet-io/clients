import React from "react";
import { StyleSheet, type ViewStyle } from "react-native";
import { useMobileShellTheme } from "../theme";
import { SkyCover } from "./mobile-sky-cover";

type MobileCardProps = {
  children: React.ReactNode;
  style?: ViewStyle;
};

export const MobileCard = ({ children, style }: MobileCardProps) => {
  const theme = useMobileShellTheme();

  return (
    <SkyCover
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surface,
          gap: theme.spacing.sm,
        },
        style,
      ]}
    >
      {children}
    </SkyCover>
  );
};

const styles = StyleSheet.create({
  card: {
    borderRadius: 18,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 5,
  },
});
