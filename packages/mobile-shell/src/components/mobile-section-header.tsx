import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useMobileShellTheme } from "../theme";

type MobileSectionHeaderProps = {
  title: string;
  icon?: React.ComponentType<{ size?: number; color?: string }>;
};

export const MobileSectionHeader = ({ title, icon: Icon }: MobileSectionHeaderProps) => {
  const theme = useMobileShellTheme();

  return (
    <View style={styles.row}>
      {Icon ? <Icon size={14} color={theme.colors.accent} /> : null}
      <Text
        style={[
          styles.title,
          {
            color: theme.colors.textDim,
            fontFamily: theme.font.family.sans,
          },
        ]}
      >
        {title.toUpperCase()}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
  },
  title: {
    fontSize: 11,
    letterSpacing: 2.4,
    fontWeight: "900",
  },
});
