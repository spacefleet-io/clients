import React, { useCallback, useEffect, useState } from "react";
import { Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { tooManyAttemptsText } from "@space/shared/signInError";
import { useTranslation } from "../i18n";
import { useMobileShellTheme } from "../theme";
import { MobileButtonFace } from "./mobile-button-face";
import { MobileRenderBoundary } from "./mobile-render-boundary";
import { TV_FOCUS_RING_WIDTH } from "./tv-focus";

type Field = "confirm" | "password" | "code";

/** The `payload.error` code of an ApiError-shaped rejection, else null. */
const apiErrorCode = (err: unknown): string | null => {
  if (!err || typeof err !== "object" || !("payload" in err)) return null;
  const payload = err.payload;
  if (!payload || typeof payload !== "object" || !("error" in payload)) return null;
  return typeof payload.error === "string" ? payload.error : null;
};

/** The word the user types to confirm. Kept literal in every language; the localized label explains it. */
export const ERASE_CONFIRM_WORD = "ERASE";

export type MobileEraseLibraryDialogProps = {
  visible: boolean;
  onCancel: () => void;
  /**
   * Erases the account's libraries (Badger and Parrot). Pass both values straight to `resetLibrary`. A rejection keeps
   * the dialog open: ApiError codes are translated here, any other Error shows its message.
   */
  onConfirm: (password: string, twoFactorCode?: string) => Promise<void>;
  /**
   * Opens the "get the key from another device" flow. Erasing is the last resort (Chris 2026-11-12): when given, a line
   * before the ERASE field points there first.
   */
  onOtherDevice?: () => void;
  /**
   * False for an account without a password (ACCT-AUTH-04): no password field; the first try sends an empty password,
   * the server answers `two_factor_required` (emailing a code unless the authenticator is on) and the code field shows.
   */
  hasPassword?: boolean;
};

/**
 * The lost-key danger dialog shared by the phone and TV key steps: erasing needs the literal word ERASE plus the
 * account password (and a two-factor code when the server asks for one). Cancel is the safe action: the TV remote starts
 * on it (Chris 2026-11-12: "Cancel focused"), and no field takes focus on open. On TV (960x540dp) the card is wider and
 * tighter so the whole dialog fits the screen without scrolling: smaller text and spacing, the ERASE and password fields
 * side by side, Cancel and Erase side by side. The field the remote is on rings in the app's colour, and the card still
 * scrolls when a notice or an error makes it taller than the screen (UX-TV-17).
 */
export const MobileEraseLibraryDialog = ({ visible, onCancel, onConfirm, onOtherDevice, hasPassword = true }: MobileEraseLibraryDialogProps) => {
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  const [confirmWord, setConfirmWord] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusedField, setFocusedField] = useState<Field | null>(null);
  const tv = Platform.isTV === true;

  useEffect(() => {
    if (!visible) return;
    setConfirmWord("");
    setPassword("");
    setCode("");
    setNeedsCode(false);
    setBusy(false);
    setError(null);
    setNotice(null);
  }, [visible]);

  const canSubmit =
    confirmWord === ERASE_CONFIRM_WORD && (!hasPassword || password.length > 0) && (!needsCode || code.trim().length > 0) && !busy;

  const submit = useCallback(async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await onConfirm(hasPassword ? password : "", needsCode ? code.trim() : undefined);
    } catch (err) {
      const apiCode = apiErrorCode(err);
      if (apiCode === "invalid_password") {
        setError(t("eraseLibrary.errorInvalidPassword"));
      } else if (apiCode === "two_factor_required") {
        setNeedsCode(true);
        setNotice(t("eraseLibrary.codeSent"));
      } else if (apiCode === "two_factor_invalid") {
        setError(t("eraseLibrary.errorTwoFactorInvalid"));
      } else {
        const rateLimited = tooManyAttemptsText(t, err);
        const plain = !apiCode && err instanceof Error && err.message ? err.message : null;
        setError(rateLimited ?? plain ?? t("eraseLibrary.errorGeneric"));
      }
    } finally {
      setBusy(false);
    }
  }, [canSubmit, code, hasPassword, needsCode, onConfirm, password, t]);

  const inputStyle = (field: Field) => [
    styles.input,
    { color: theme.colors.text, borderColor: theme.colors.controlBorder, backgroundColor: theme.colors.surfaceRaised },
    tv && styles.inputTv,
    tv && { borderWidth: TV_FOCUS_RING_WIDTH },
    tv && focusedField === field && { borderColor: theme.colors.accent },
  ];
  const bodyStyle = [styles.body, tv && styles.bodyTv];
  const labelStyle = [styles.label, tv && styles.labelTv, { color: theme.colors.text }];
  const boxStyle = [styles.box, tv && styles.boxTv];
  const fieldStyle = [styles.field, tv && styles.fieldTv];
  const focusProps = (field: Field) => ({
    onFocus: () => setFocusedField(field),
    onBlur: () => setFocusedField((current) => (current === field ? null : current)),
  });
  const dangerTint = { borderColor: "rgba(237,128,132,0.45)", backgroundColor: "rgba(237,128,132,0.12)" };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      {/* UX-CRASH-01: a crash inside the dialog closes it; the window guard says why. */}
      <MobileRenderBoundary name="modal:erase-library" onDismiss={onCancel}>
        <View style={[styles.backdrop, tv && styles.backdropTv]}>
          <View
            style={[styles.card, tv && styles.cardTv, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}
            testID="erase-library-dialog"
          >
            <ScrollView contentContainerStyle={[styles.content, tv && styles.contentTv]}>
            <Text style={[styles.title, tv && styles.titleTv, { color: theme.colors.danger }]} accessibilityRole="header">
              {t("eraseLibrary.title")}
            </Text>
            <View style={[boxStyle, dangerTint]}>
              <Text style={[bodyStyle, { color: theme.colors.danger }]}>{t("eraseLibrary.warning")}</Text>
            </View>

            {onOtherDevice ? (
              <View style={fieldStyle}>
                <Text style={[bodyStyle, { color: theme.colors.text }]}>{t("eraseLibrary.otherDeviceLine")}</Text>
                <MobileButtonFace
                  label={t("eraseLibrary.otherDeviceLink")}
                  variant="ghost"
                  onPress={onOtherDevice}
                  disabled={busy}
                  testID="erase-library-other-device"
                />
              </View>
            ) : null}

            <View style={tv ? styles.fieldsRowTv : styles.fields}>
            <View style={[fieldStyle, tv && styles.rowFieldTv]}>
              <Text style={labelStyle}>
                {t("eraseLibrary.confirmLabel", { word: ERASE_CONFIRM_WORD })}
              </Text>
              <TextInput
                testID="erase-library-confirm"
                accessibilityLabel={t("eraseLibrary.confirmLabel", { word: ERASE_CONFIRM_WORD })}
                value={confirmWord}
                onChangeText={setConfirmWord}
                style={inputStyle("confirm")}
                {...focusProps("confirm")}
                autoCapitalize="characters"
                autoCorrect={false}
                spellCheck={false}
                autoComplete="off"
                importantForAutofill="no"
                textContentType="none"
                editable={!busy}
              />
            </View>

            {hasPassword ? (
              <View style={[fieldStyle, tv && styles.rowFieldTv]}>
                <Text style={labelStyle}>{t("eraseLibrary.passwordLabel")}</Text>
                <TextInput
                  testID="erase-library-password"
                  accessibilityLabel={t("eraseLibrary.passwordLabel")}
                  value={password}
                  onChangeText={setPassword}
                  style={inputStyle("password")}
                  {...focusProps("password")}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  autoComplete="current-password"
                  textContentType="password"
                  editable={!busy}
                />
              </View>
            ) : (
              <View style={[fieldStyle, tv && styles.rowFieldTv]}>
                <Text testID="erase-library-recheck-hint" style={[bodyStyle, { color: theme.colors.text }]}>{t("login.code.recheckHint")}</Text>
              </View>
            )}
            </View>

            {needsCode ? (
              <View style={fieldStyle}>
                <Text style={labelStyle}>{t("eraseLibrary.codeLabel")}</Text>
                <TextInput
                  testID="erase-library-code"
                  accessibilityLabel={t("eraseLibrary.codeLabel")}
                  value={code}
                  onChangeText={setCode}
                  style={inputStyle("code")}
                  {...focusProps("code")}
                  keyboardType="number-pad"
                  autoComplete="one-time-code"
                  textContentType="oneTimeCode"
                  autoCorrect={false}
                  editable={!busy}
                />
              </View>
            ) : null}

            {notice ? (
              <Text style={[styles.notice, { color: theme.colors.textMuted }]} testID="erase-library-notice">
                {notice}
              </Text>
            ) : null}
            {error ? (
              <View style={[boxStyle, dangerTint]} accessibilityLiveRegion="polite">
                <Text style={[styles.errorText, { color: theme.colors.danger }]} testID="erase-library-error">
                  {error}
                </Text>
              </View>
            ) : null}

            <View style={[styles.actions, tv && styles.actionsTv]}>
              <View style={tv ? styles.actionTv : undefined}>
                <MobileButtonFace
                  label={t("eraseLibrary.cancel")}
                  variant="secondary"
                  hasTVPreferredFocus
                  onPress={onCancel}
                  disabled={busy}
                  testID="erase-library-cancel"
                />
              </View>
              <View style={tv ? styles.actionTv : undefined}>
                <MobileButtonFace
                  label={busy ? t("eraseLibrary.working") : t("eraseLibrary.submit")}
                  variant="danger"
                  onPress={() => void submit()}
                  disabled={!canSubmit}
                  loading={busy}
                  testID="erase-library-submit"
                />
              </View>
            </View>
            </ScrollView>
          </View>
        </View>
      </MobileRenderBoundary>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 440,
    maxHeight: "100%",
    borderRadius: 20,
    borderWidth: 1,
    overflow: "hidden",
  },
  backdropTv: { padding: 12 },
  cardTv: { maxWidth: 760 },
  content: {
    padding: 20,
    gap: 12,
  },
  contentTv: { padding: 16, gap: 8 },
  title: {
    fontSize: 18,
    fontWeight: "800",
  },
  titleTv: { fontSize: 16 },
  box: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  boxTv: { paddingVertical: 8, paddingHorizontal: 10 },
  body: {
    fontSize: 14,
    lineHeight: 20,
  },
  bodyTv: { fontSize: 12, lineHeight: 16 },
  field: {
    gap: 6,
  },
  fields: { gap: 12 },
  fieldsRowTv: { flexDirection: "row", gap: 12 },
  fieldTv: { gap: 4 },
  rowFieldTv: { flex: 1 },
  label: {
    fontSize: 14,
    fontWeight: "600",
  },
  labelTv: { fontSize: 12 },
  input: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  inputTv: { paddingVertical: 6, fontSize: 14 },
  notice: {
    fontSize: 13,
    lineHeight: 18,
  },
  errorText: {
    fontSize: 13,
    lineHeight: 18,
  },
  actions: {
    gap: 10,
    marginTop: 4,
  },
  actionsTv: { flexDirection: "row" },
  actionTv: { flex: 1 },
});
