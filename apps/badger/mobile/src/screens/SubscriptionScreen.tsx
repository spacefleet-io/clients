import React, { useCallback } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ArrowLeft } from "lucide-react-native";
import { useTranslation } from "@space/mobile-shell/i18n";
import { MobileIconButton, MobileSkeletonBlock, MobileSkeletonPulse } from "@space/mobile-shell/components";
import { MobileAccountPlanPanel } from "@space/mobile-shell/account-plan-panel";
import { useAuth } from "../store/auth";
import { SettingsGroup } from "../components/SettingsRows";
import { theme } from "../theme/theme";

/** One titled card of the panel, padded like Badger's other settings cards. */
const PlanGroup = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <SettingsGroup title={title}>
    <View style={styles.card}>{children}</View>
  </SettingsGroup>
);

/** Read-only account status: plan, access state and storage (the shared panel). Never takes payment or links to it (ACCT-PAY-02). */
export const SubscriptionScreen = () => {
  const { t } = useTranslation();
  const { token } = useAuth();
  const navigation = useNavigation();
  const goBack = useCallback(() => navigation.goBack(), [navigation]);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}>
        <MobileIconButton label={t("subscription.back")} onPress={goBack}>
          <ArrowLeft size={22} color={theme.colors.text} />
        </MobileIconButton>
        <Text style={styles.title} accessibilityRole="header">
          {t("subscription.title")}
        </Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {token ? (
          <MobileAccountPlanPanel
            token={token}
            Group={PlanGroup}
            placeholder={
              <MobileSkeletonPulse style={styles.skeleton}>
                <MobileSkeletonBlock width="100%" height={110} radius={16} />
                <MobileSkeletonBlock width="100%" height={130} radius={16} />
              </MobileSkeletonPulse>
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
  content: { paddingTop: 8, paddingBottom: 24, gap: 20 },
  skeleton: { gap: 16 },
  card: { padding: 16 },
});
