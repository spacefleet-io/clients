import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { Button, Input, SectionHeader } from "../components/ui";
import { Screen } from "../components/Screen";
import { useAuth } from "../store/auth";
import { useLibrary } from "../store/library";
import { ApiError, rotateLibraryKey } from "@space/shared/api";
import { encryptBytesToBase64 } from "../lib/crypto";
import { generateLibraryKeyWords, type NewLibraryKey } from "@space/shared/libraryKeyWords";
import { LibraryKeyWordsGrid } from "@space/mobile-shell/libraryKeyWords";
import { setStoredLibraryKey } from "../lib/onboarding";
import { useTranslation } from "@space/mobile-shell/i18n";
import { theme } from "../theme/theme";

export const ResetKeyScreen = () => {
  const { t, i18n } = useTranslation();
  const { token, user } = useAuth();
  // ACCT-AUTH-04: an account without a password is asked a code instead (the first try emails one).
  const hasPassword = user?.hasPassword !== false;
  const { exportBytes, reload } = useLibrary();
  const [fresh, setFresh] = useState<NewLibraryKey | null>(null);
  const newKey = fresh?.keyBase64 ?? null;
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"confirmRequired" | "passwordRequired" | "notReady" | "rotate" | "codeSent" | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    setFresh(generateLibraryKeyWords(i18n?.language));
  }, []);

  const handleRotate = useCallback(async () => {
    if (!token || !newKey) return;
    setError(null);
    setSuccess(false);
    if (!confirmed) {
      setError("confirmRequired");
      return;
    }
    if (hasPassword && !password) {
      setError("passwordRequired");
      return;
    }
    const bytes = await exportBytes();
    if (!bytes) {
      setError("notReady");
      return;
    }
    setBusy(true);
    try {
      const blobBase64 = await encryptBytesToBase64(newKey, bytes);
      const probeBytes = new Uint8Array(32);
      global.crypto.getRandomValues(probeBytes);
      const keyProbe = await encryptBytesToBase64(newKey, probeBytes);
      await rotateLibraryKey(token, blobBase64, keyProbe, hasPassword ? password : "", code || undefined);
      await setStoredLibraryKey(newKey);
      setSuccess(true);
      reload();
    } catch (err) {
      // Without a password the first try emails a code (or asks the authenticator's): say where to type it.
      setError(!hasPassword && err instanceof ApiError && err.payload?.error === "two_factor_required" ? "codeSent" : "rotate");
    } finally {
      setBusy(false);
    }
  }, [code, confirmed, exportBytes, hasPassword, newKey, password, reload, token]);

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scroll}>
        <SectionHeader
          title={t("resetKey.title")}
          subtitle={t("resetKey.subtitle")}
        />
        <View style={styles.card}>
          <Text style={styles.label}>{t("resetKey.newKey")}</Text>
          <LibraryKeyWordsGrid words={fresh?.words ?? []} />
          <Button
            label={t("resetKey.generateAnother")}
            variant="secondary"
            onPress={() => setFresh(generateLibraryKeyWords(i18n?.language))}
          />
        </View>
        {hasPassword ? (
          <Input label={t("resetKey.password")} value={password} onChangeText={setPassword} secureTextEntry />
        ) : (
          <Text testID="reset-key-recheck-hint" style={styles.label}>{t("login.code.recheckHint")}</Text>
        )}
        <Input label={t("resetKey.code")} value={code} onChangeText={setCode} />
        <View style={styles.card}>
          <Text style={styles.confirmLabel}>{t("resetKey.confirmLabel")}</Text>
          <Button
            label={confirmed ? t("resetKey.confirmed") : t("resetKey.confirm")}
            variant={confirmed ? "secondary" : "primary"}
            onPress={() => setConfirmed((prev) => !prev)}
          />
        </View>
        {error ? <Text style={styles.error}>{error === "codeSent" ? t("login.code.recheckSent") : t(`resetKey.errors.${error}`)}</Text> : null}
        {success ? <Text style={styles.success}>{t("resetKey.success")}</Text> : null}
        <Button label={busy ? t("resetKey.rotating") : t("resetKey.rotate")} onPress={handleRotate} loading={busy} />
      </ScrollView>
    </Screen>
  );
};

const styles = StyleSheet.create({
  scroll: {
    gap: theme.spacing.lg,
  },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: theme.spacing.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: theme.spacing.sm,
  },
  label: {
    color: theme.colors.textMuted,
    fontSize: theme.font.size.sm,
  },
  confirmLabel: {
    color: theme.colors.text,
  },
  error: {
    color: theme.colors.danger,
  },
  success: {
    color: theme.colors.success,
  },
});
