// REL-LOG-06: the small "What's in a report?" link under the one-line error-reports explanation. It opens the error
// reports item of the privacy policy on spacefleet.io in the app's language; the details live there, not in the app.
import React from "react";
import { Linking, StyleSheet, Text, type TextStyle } from "react-native";
import { errorReportsPrivacyUrl } from "@space/shared/websiteLinks";
import { getCurrentLanguage, useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";

type MobileErrorReportsLinkProps = {
  testID?: string;
  style?: TextStyle;
};

export const MobileErrorReportsLink = ({ testID = "error-reports-link", style }: MobileErrorReportsLinkProps) => {
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  return (
    <Text
      testID={testID}
      accessibilityRole="link"
      style={[styles.link, { color: theme.colors.accent }, style]}
      onPress={() => void Linking.openURL(errorReportsPrivacyUrl(getCurrentLanguage()))}
    >
      {t("settings.privacy.errorReports.link")}
    </Text>
  );
};

const styles = StyleSheet.create({
  link: {
    fontSize: 13,
    fontWeight: "600",
    textDecorationLine: "underline",
  },
});
