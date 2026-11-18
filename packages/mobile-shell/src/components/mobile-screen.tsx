import React from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useMobileShellTheme } from "../theme";
import MobileAppBackdrop from "./mobile-app-backdrop";

type MobileScreenProps = {
  children: React.ReactNode;
  style?: ViewStyle;
};

/** A plain full-screen page over the app's sky and nebula (UX-SKY-02, UX-SKY-03). */
export const MobileScreen = ({ children, style }: MobileScreenProps) => {
  const theme = useMobileShellTheme();
  const insets = useSafeAreaInsets();

  return (
    <SafeAreaView style={styles.safe}>
      <MobileAppBackdrop />
      <View
        style={[
          styles.container,
          {
            paddingTop: insets.top + theme.spacing.md,
            paddingBottom: insets.bottom + theme.spacing.md,
            padding: theme.spacing.lg,
            gap: theme.spacing.lg,
          },
          style,
        ]}
      >
        {children}
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
});
