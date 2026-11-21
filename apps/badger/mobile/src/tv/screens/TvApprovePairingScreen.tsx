import React, { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, type TextInputInstance, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useMobileShellTheme } from "@space/mobile-shell/theme";
import { useTranslation } from "@space/mobile-shell/i18n";
import { ShortCodeInput } from "@space/mobile-shell/short-code";
import { SHORT_CODE_LENGTH } from "@space/pairing-crypto";
import { pairingDeps } from "../../lib/pairing/pairingDeps";
import {
  PairingFlowError,
  approvalQuestion,
  approveDevice,
  denyDevice,
  lookupDevice,
  pairingErrorMessage,
  type ApprovalProof,
  type PairingRequestInfo,
} from "@space/mobile-shell/pairing-approve";
import { rememberSession } from "../../lib/pairing/deviceWatch";
import { useAuth } from "../../store/auth";
import { PairingButton } from "@space/mobile-shell/tv/PairingButton";
import { TV_RADIUS } from "../lib/tvLook";
import { useTvStyles } from "@space/mobile-shell/tv/tvScale";

type Stage =
  | { name: "code"; error: string | null }
  | { name: "looking" }
  | { name: "confirm"; request: PairingRequestInfo }
  /**
   * The proof is being asked: the account password, or (an account without a password, ACCT-AUTH-04) the code the API
   * emailed or the authenticator's (`method`). `error` once the API said the last one was wrong.
   */
  | { name: "password"; request: PairingRequestInfo; error: string | null; secret: "password" | "code"; method: "email" | "totp" }
  | { name: "approving"; request: PairingRequestInfo }
  | { name: "done"; request: PairingRequestInfo; added: boolean }
  | { name: "failed"; message: string };

const failureMessage = (error: unknown): string =>
  error instanceof PairingFlowError ? pairingErrorMessage(error.kind, error.retryAfterMinutes) : pairingErrorMessage("unknown");

/**
 * Approving another device from a TV (ACCT-PAIR-01, ACCT-PAIR-02). There is no camera on a TV, so the code
 * is typed; the approval shows who is asking with the warning, then asks for the ACCOUNT PASSWORD. The password
 * goes to the API with the approval and is checked there before anything is approved: a wrong one leaves the
 * request pending and the user may type it again. An account without a password (ACCT-AUTH-04) is asked a code
 * instead: Approve sends no proof, the API emails a code (or asks the authenticator's), and the code is typed here.
 */
export const TvApprovePairingScreen = () => {
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  const navigation = useNavigation();
  const { token, user } = useAuth();
  const hasPassword = user?.hasPassword !== false;
  const [stage, setStage] = useState<Stage>({ name: "code", error: null });
  const [code, setCode] = useState("");
  const [typed, setTyped] = useState("");
  const mounted = useRef(true);
  const inputRef = useRef<TextInputInstance>(null);
  const styles = useTvStyles(baseStyles);

  // `hasTVPreferredFocus` is only implemented by the native View / Pressable, not by TextInput, so the field never
  // asked for the focus itself: it got it on first mount only because it is the first focusable view. After the
  // confirm step (whose focused button unmounts in the same commit) nothing took the focus, and the password field
  // came up unfocused. Ask for it explicitly whenever a text field appears.
  const typing = stage.name === "code" || stage.name === "password";
  useEffect(() => {
    if (!typing) return undefined;
    const id = setTimeout(() => {
      console.info("[tv.approve] input.focus", { stage: stage.name, found: inputRef.current !== null });
      inputRef.current?.focus();
    }, 80);
    return () => clearTimeout(id);
  }, [typing, stage.name]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const goBack = useCallback(() => navigation.goBack(), [navigation]);

  const submitCode = useCallback(async () => {
    if (!token) return;
    setStage({ name: "looking" });
    try {
      const request = await lookupDevice(pairingDeps, token, code);
      if (mounted.current) setStage({ name: "confirm", request });
    } catch (error) {
      console.info("[tv.approve] lookup.failed", { kind: error instanceof PairingFlowError ? error.kind : "unknown" });
      if (mounted.current) setStage({ name: "code", error: failureMessage(error) });
    }
  }, [code, token]);

  const askPassword = useCallback((request: PairingRequestInfo) => {
    setTyped("");
    setStage({ name: "password", request, error: null, secret: "password", method: "email" });
  }, []);

  const approve = useCallback(
    async (request: PairingRequestInfo, proof: ApprovalProof, method: "email" | "totp" = "email") => {
      if (!token) return;
      setStage({ name: "approving", request });
      try {
        const { sessionId } = await approveDevice(pairingDeps, token, request, proof);
        // Same as the phone: not announced as "new" later, and the TV's devices dialog reloads at once.
        if (sessionId) await rememberSession(sessionId);
        if (mounted.current) setStage({ name: "done", request, added: true });
      } catch (error) {
        const kind = error instanceof PairingFlowError ? error.kind : "unknown";
        console.info("[tv.approve] approve.failed", { kind });
        if (!mounted.current) return;
        if (kind === "wrong_password") {
          // The API left the request pending: ask again.
          setTyped("");
          setStage({ name: "password", request, error: failureMessage(error), secret: "password", method: "email" });
        } else if (kind === "code_required" && error instanceof PairingFlowError) {
          // No password on the account: the API sent a code (or wants the authenticator's). Still pending.
          setTyped("");
          setStage({ name: "password", request, error: null, secret: "code", method: error.codeMethod });
        } else if (kind === "code_invalid") {
          setTyped("");
          setStage({ name: "password", request, error: failureMessage(error), secret: "code", method });
        } else {
          setStage({ name: "failed", message: failureMessage(error) });
        }
      }
    },
    [token],
  );

  const deny = useCallback(
    async (request: PairingRequestInfo) => {
      if (token) await denyDevice(pairingDeps, token, request).catch(() => undefined);
      if (mounted.current) setStage({ name: "done", request, added: false });
    },
    [token],
  );

  const heading = (text: string) => <Text style={[styles.title, { color: theme.colors.text }]}>{text}</Text>;
  const body = (text: string, tone: "muted" | "danger" = "muted") => (
    <Text style={[styles.body, { color: tone === "danger" ? theme.colors.danger : theme.colors.textMuted }]}>{text}</Text>
  );
  const input = (props: React.ComponentProps<typeof TextInput>) => (
    <TextInput
      {...props}
      ref={inputRef}
      focusable
      placeholderTextColor={theme.colors.textDim}
      style={[styles.input, { color: theme.colors.text, backgroundColor: theme.colors.surfaceRaised }]}
    />
  );

  let content: React.ReactNode;
  if (stage.name === "password") {
    const { request, secret, method } = stage;
    const asksCode = secret === "code";
    const proof = (): ApprovalProof => (asksCode ? { code: typed.trim() } : { password: typed });
    content = (
      <>
        {heading(asksCode ? t("tvPairing.approve.code.title") : t("tvPairing.approve.password.title"))}
        {body(asksCode ? t(method === "totp" ? "tvPairing.approve.code.detailTotp" : "tvPairing.approve.code.detailEmail") : t("tvPairing.approve.password.detail"))}
        {stage.error ? body(stage.error, "danger") : null}
        {input({
          testID: "tv-approve-secret",
          value: typed,
          onChangeText: setTyped,
          secureTextEntry: !asksCode,
          ...(asksCode ? { keyboardType: "number-pad" as const, textContentType: "oneTimeCode" as const } : {}),
          autoCapitalize: "none",
          autoCorrect: false,
          accessibilityLabel: asksCode ? t("tvPairing.approve.code.label") : t("tvPairing.approve.password.label"),
          onSubmitEditing: () => typed.trim() && void approve(request, proof(), method),
        })}
        <View style={styles.actions}>
          <PairingButton
            testID="tv-approve-secret-submit"
            variant="primary"
            disabled={!typed.trim()}
            label={t("tvPairing.approve.continue")}
            onPress={() => void approve(request, proof(), method)}
          />
          <PairingButton testID="tv-approve-secret-cancel" label={t("tvPairing.approve.cancel")} onPress={() => setStage({ name: "confirm", request })} />
        </View>
      </>
    );
  } else if (stage.name === "code") {
    content = (
      <>
        {heading(t("tvPairing.approve.title"))}
        {body(t("tvPairing.approve.subtitle"))}
        {stage.error ? body(stage.error, "danger") : null}
        {/* ACCT-PAIR-01: 8 boxes in two groups of 4; typed with or without a dash or spaces, in any case. */}
        <ShortCodeInput
          ref={inputRef}
          testID="tv-approve-code"
          value={code}
          onChange={setCode}
          accessibilityLabel={t("tvPairing.approve.codeLabel")}
          onSubmit={() => {
            if (code.length === SHORT_CODE_LENGTH) void submitCode();
          }}
          style={styles.code}
        />
        <View style={styles.actions}>
          <PairingButton
            testID="tv-approve-lookup"
            variant="primary"
            disabled={code.length !== SHORT_CODE_LENGTH}
            label={t("tvPairing.approve.continue")}
            onPress={() => void submitCode()}
          />
          <PairingButton testID="tv-approve-back" label={t("tvPairing.approve.back")} onPress={goBack} />
        </View>
      </>
    );
  } else if (stage.name === "looking") {
    content = body(t("pairing.looking"));
  } else if (stage.name === "confirm") {
    const { request } = stage;
    content = (
      <>
        {heading(approvalQuestion(request))}
        {body(t("tvPairing.approve.warning"))}
        {body(hasPassword ? t("tvPairing.approve.passwordNotice") : t("tvPairing.approve.codeNotice"))}
        <View style={styles.actions}>
          <PairingButton
            testID="tv-approve-approve"
            variant="primary"
            preferredFocus
            label={t("pairing.confirm.approve")}
            onPress={() => (hasPassword ? askPassword(request) : void approve(request, { code: null }))}
          />
          <PairingButton testID="tv-approve-deny" label={t("pairing.confirm.deny")} onPress={() => void deny(request)} />
        </View>
      </>
    );
  } else if (stage.name === "approving") {
    content = body(hasPassword ? t("tvPairing.approve.approving") : t("tvPairing.approve.approvingCode"));
  } else if (stage.name === "done") {
    content = (
      <>
        {heading(stage.added ? t("pairing.done.added", { name: stage.request.deviceName }) : t("pairing.done.notAdded", { name: stage.request.deviceName }))}
        {body(stage.added ? t("tvPairing.approve.addedDetail") : t("pairing.done.notAddedDetail"))}
        <PairingButton testID="tv-approve-done" variant="primary" preferredFocus label={t("pairing.done.done")} onPress={goBack} />
      </>
    );
  } else {
    content = (
      <>
        {heading(t("pairing.failed.didntWork"))}
        {body(stage.message, "danger")}
        <View style={styles.actions}>
          <PairingButton testID="tv-approve-retry" variant="primary" preferredFocus label={t("pairing.failed.tryAnother")} onPress={() => setStage({ name: "code", error: null })} />
          <PairingButton testID="tv-approve-back" label={t("tvPairing.approve.back")} onPress={goBack} />
        </View>
      </>
    );
  }

  return <View style={styles.screen}>{content}</View>;
};

const baseStyles = StyleSheet.create({
  screen: { flex: 1, paddingHorizontal: 120, paddingVertical: 64, gap: 20, justifyContent: "center" },
  title: { fontSize: 40, fontWeight: "800" },
  body: { fontSize: 24, lineHeight: 34 },
  input: { fontSize: 32, paddingVertical: 14, paddingHorizontal: 20, borderRadius: TV_RADIUS.button, maxWidth: 700, letterSpacing: 4 },
  actions: { flexDirection: "row", gap: 24, marginTop: 8 },
  code: { alignSelf: "flex-start" },
});
