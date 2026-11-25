import React, { useCallback, useEffect } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import type { Session } from "@space/shared/api";
import { useTranslation } from "@space/mobile-shell/i18n";
import { useMobileShellTheme } from "@space/mobile-shell/theme";
import { MobileSheetScrollView } from "@space/mobile-shell/bottom-sheet";
import { Button, Card } from "./ui";
import { BottomSheet } from "./BottomSheet";
import { usePickerSheet } from "./usePickerSheet";
import { sessionDetail, sessionDisplayName, useAccountDevices } from "../lib/accountDevices";

/**
 * The account's signed-in devices (ACCT-DEV-01). Settings shows only a summary and one button; the full list, with
 * type, name, last seen and a sign-out button per device, opens in its own scrolling sheet (UX-LIST-01).
 *
 * @param openRequest bumped to open the list from outside (the new-device banner, ACCT-PAIR-03); 0 = never.
 */
export const DevicesSection = ({ token, openRequest = 0 }: { token: string; openRequest?: number }) => {
  const sheet = usePickerSheet();
  const openSheet = sheet.open;
  useEffect(() => {
    if (openRequest > 0) openSheet();
  }, [openRequest, openSheet]);
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  const { sessions, loading, error, load, signOut } = useAccountDevices(token);

  const confirmSignOut = useCallback(
    (session: Session) => {
      Alert.alert(t("account.devices.confirmTitle", { name: sessionDisplayName(session) }), t("account.devices.confirmExplanation"), [
        { text: t("account.devices.cancel"), style: "cancel" },
        { text: t("account.devices.revoke"), style: "destructive", onPress: () => void signOut(session) },
      ]);
    },
    [signOut, t],
  );

  const current = sessions.find((session) => session.current);
  const summary =
    sessions.length === 0
      ? loading
        ? t("account.devices.loading")
        : t("account.devices.empty")
      : t("account.devices.summary", { count: sessions.length });

  return (
    <Card>
      <Text style={[styles.title, { color: theme.colors.textDim }]}>{t("account.devices.title").toUpperCase()}</Text>
      {error ? <Text style={[styles.line, { color: theme.colors.danger }]}>{t(`account.devices.errors.${error}`)}</Text> : null}
      <Text style={[styles.line, { color: theme.colors.textMuted }]} testID="devices-summary">
        {summary}
      </Text>
      {current ? (
        <Text style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>
          {t("account.devices.thisDevice", { name: sessionDisplayName(current) })}
        </Text>
      ) : null}
      <Button label={t("account.devices.manage", { count: sessions.length })} variant="secondary" onPress={sheet.open} />
      <BottomSheet sheet={sheet} testID="devices-sheet">
        <Text style={[styles.sheetTitle, { color: theme.colors.text }]}>{t("account.devices.title")}</Text>
        {error ? <Text style={[styles.line, { color: theme.colors.danger }]}>{t(`account.devices.errors.${error}`)}</Text> : null}
        <MobileSheetScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator>
          {sessions.map((session) => (
            <View key={session.id} style={styles.row} testID="device-row">
              <View style={styles.info}>
                <Text style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>
                  {session.current
                    ? t("account.devices.thisDevice", { name: sessionDisplayName(session) })
                    : sessionDisplayName(session)}
                </Text>
                <Text style={[styles.line, { color: theme.colors.textMuted }]}>
                  {sessionDetail(session)}
                </Text>
              </View>
              {!session.current ? (
                <Button label={t("account.devices.revoke")} variant="ghost" onPress={() => confirmSignOut(session)} />
              ) : null}
            </View>
          ))}
          <Text style={[styles.line, { color: theme.colors.textDim }]}>{t("account.devices.footnote")}</Text>
        </MobileSheetScrollView>
        <Button label={t("account.devices.refresh")} variant="secondary" onPress={() => void load()} loading={loading} />
      </BottomSheet>
    </Card>
  );
};

const styles = StyleSheet.create({
  title: { fontSize: 12, fontWeight: "800", letterSpacing: 1 },
  sheetTitle: { fontSize: 17, fontWeight: "800", paddingHorizontal: 4 },
  list: { gap: 14, paddingVertical: 4 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  info: { flex: 1, gap: 2 },
  name: { fontSize: 16, fontWeight: "700" },
  line: { fontSize: 13, lineHeight: 18 },
});
