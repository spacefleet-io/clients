import React from "react";
import { Pressable, StyleSheet } from "react-native";
import { Settings } from "lucide-react-native";
import { useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";

type MobileAuthSettingsBarProps = {
  languageMenu: React.ReactNode;
  /** Opens the server picker. Leave it out where the build has none (ACCT-AUTH-09: release builds): no button then. */
  onApiHostPress?: () => void;
};

export const MobileAuthSettingsBar = ({
  languageMenu,
  onApiHostPress,
}: MobileAuthSettingsBarProps) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();

  return (
    <>
      {languageMenu}
      {onApiHostPress ? (
        <Pressable
          style={[styles.iconBtn, { borderColor: theme.colors.border }]}
          onPress={onApiHostPress}
          accessibilityLabel={t("authApiHost.button")}
          accessibilityRole="button"
        >
          <Settings size={16} color={theme.colors.textMuted} />
        </Pressable>
      ) : null}
    </>
  );
};

const styles = StyleSheet.create({
  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
