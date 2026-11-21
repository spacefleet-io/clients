import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowLeft } from "lucide-react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { finishAccountDeletion } from "@space/mobile-shell/account-deletion";
import { MobileDeleteAccount } from "@space/mobile-shell/delete-account";
import { useAuth } from "../store/auth";
import { IconButton } from "../components/IconButton";
import { clearLibraryKey } from "../lib/onboarding";
import { removeDownloads } from "../lib/downloads/downloadActions";
import { getDownloadsState } from "../lib/downloads/downloadsStore";
import { theme } from "../theme/theme";

/**
 * Settings → Delete account (phone only; ACCT-DEL-01/02/03): the shared phone form (`MobileDeleteAccount`) under the
 * page's title. After an immediate deletion the account's offline files and library key leave the phone, then the
 * session ends.
 */
export const DeleteAccountScreen = () => {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const { token, user, logout, refresh, setUser } = useAuth();
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <IconButton label={t("deleteAccount.back")} onPress={() => navigation.goBack()}>
          <ArrowLeft size={22} color={theme.colors.text} />
        </IconButton>
        <Text style={styles.title} accessibilityRole="header">
          {t("deleteAccount.title")}
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {token ? (
          <MobileDeleteAccount
            token={token}
            // ACCT-AUTH-04: an account without a password is asked a code instead (the first try emails one).
            hasPassword={user ? user.hasPassword !== false : undefined}
            onUserChanged={setUser}
            onBooked={() => void refresh()}
            onDeleted={() =>
              finishAccountDeletion({
                downloadIds: getDownloadsState().items.map((item) => item.id),
                removeDownloads,
                clearLibraryKey,
                logout: () => logout("signOut"),
              })
            }
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, paddingHorizontal: 16 },
  header: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4 },
  title: { flex: 1, fontSize: 22, fontWeight: "800", color: theme.colors.text, fontFamily: theme.font.family.display },
  content: { paddingTop: 8, paddingBottom: 24 },
});
