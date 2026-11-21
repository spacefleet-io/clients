// Settings → Delete account (ACCT-DEL-01/02/03): the phones' shared form over the sky, under the round back button
// every pushed page floats (UX-SKY-04). A phone creates accounts, so it deletes them too (Apple 5.1.1(v), Google Play's
// account deletion requirement). After an immediate deletion the sign-out removes the library and its key from the phone.
import React from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileDeleteAccount } from "@space/mobile-shell/delete-account";
import { useSession } from "../state/session";
import { colors, spacing } from "../theme";
import { PageBackButton, usePageTop } from "./pageBack";
import type { RootStack } from "./routes";

export const DeleteAccountScreen = ({ navigation }: NativeStackScreenProps<RootStack, "DeleteAccount">) => {
  const { t } = useTranslation();
  const { session, signOut } = useSession();
  const top = usePageTop();
  return (
    <>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.scroll, { paddingTop: top }]} keyboardShouldPersistTaps="handled">
        <Text style={styles.title} accessibilityRole="header">
          {t("deleteAccount.title")}
        </Text>
        {session ? <MobileDeleteAccount token={session.token} onDeleted={() => signOut().catch(() => undefined)} /> : null}
      </ScrollView>
      <PageBackButton onPress={() => navigation.goBack()} />
    </>
  );
};

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xl, gap: spacing.lg },
  title: { color: colors.text, fontSize: 22, fontWeight: "800" },
});
