/**
 * Creating a free account on a phone (ACCT-AUTH-10), shared by the Badger and Parrot phones: the same fields, checks
 * and legal line as the desktop apps and the website (email, password twice, the unticked News box, "By creating an
 * account, you accept…"), then the code the API emails, which signs the person in. No price and no payment anywhere:
 * the account is free, and paying stays off the phones (ACCT-PAY-02).
 */
import React, { useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View, type TextInputInstance } from "react-native";
import { Check, Lock, Mail } from "lucide-react-native";
import { newsOptInText, parseLegalInline, LEGAL_CONTENT, resolveLegalLanguage } from "@space/legal";
import { resendVerification, signup, verifyEmail, type LoginDevice, type User } from "@space/shared/api";
import type { AccountLanguage } from "@space/shared/i18n";
import { isRateLimited, signInErrorValues, TOO_MANY_ATTEMPTS_KEY, type SignInErrorValues } from "@space/shared/signInError";
import {
  checkSignUpInput,
  classifyResendVerificationError,
  classifySignUpError,
  classifyVerifyEmailError,
  disposableEmailCheck,
} from "@space/shared/signUp";
import { legalPageUrl } from "@space/shared/websiteLinks";
import { useTranslation } from "../i18n";
import { scopeLogger } from "../logger";
import { useMobileShellTheme } from "../theme";
import { MobileAuthButton, MobileAuthInput, MobileAuthLink } from "./mobile-auth-form";

const log = scopeLogger("sign-up");

/** Without the build's domain lists the API alone refuses a throwaway address (ACCT-AUTH-02). */
const isDisposableEmail = disposableEmailCheck();

export type MobileSignUpStep = "form" | "verify";

type Notice = { kind: "error" | "info"; key: string; values?: SignInErrorValues };

export type MobileSignUpProps = {
  initialEmail: string;
  /** `verify`: a sign-in answered "email not verified", so the code step opens at once (the desktop does the same). */
  initialStep?: MobileSignUpStep;
  /** The app's language: the account's language at sign-up (ACCT-EMAIL-01) and the legal pages' language. */
  language: string;
  uiLanguage?: AccountLanguage;
  /** What the account's device list calls this phone once the code signs it in (ACCT-DEV-01). */
  device: LoginDevice;
  /** Starts the session the code returned. */
  onSignedIn: (token: string, user: User) => Promise<void>;
  /** "Already have an account? Sign in": back to the sign-in form with the email typed so far. */
  onSignIn: (email: string) => void;
  /** The Google, Apple and Microsoft rows the app draws under an "or" line, labelled "Sign up with …" (ACCT-SIGNIN-05). */
  providerRows?: React.ReactNode;
};

/**
 * The sign-up line (WEB-LEGAL-18): creating an account accepts the terms, no box. Its page links open the legal page
 * on spacefleet.io in the system browser. Shown under the sign-up form and under the provider rows, which create an
 * account for a new email (ACCT-AUTH-10).
 */
export const MobileSignUpTermsNotice = ({ language, testID = "signup-terms-notice" }: { language: string; testID?: string }) => {
  const theme = useMobileShellTheme();
  const text = LEGAL_CONTENT[resolveLegalLanguage(language)].consent.signup;
  return (
    <Text testID={testID} style={[styles.legal, { color: theme.colors.textMuted }]}>
      {parseLegalInline(text).map((part, index) =>
        part.kind === "text" ? (
          <Text key={index}>{part.text}</Text>
        ) : (
          <Text
            key={index}
            accessibilityRole="link"
            style={{ color: theme.colors.accent, textDecorationLine: "underline" }}
            onPress={() => void Linking.openURL(part.kind === "page" ? legalPageUrl(language, part.slug) : part.href)}
          >
            {part.text}
          </Text>
        )
      )}
    </Text>
  );
};

export const MobileSignUp = ({ initialEmail, initialStep = "form", language, uiLanguage, device, onSignedIn, onSignIn, providerRows }: MobileSignUpProps) => {
  const theme = useMobileShellTheme();
  const { t } = useTranslation();
  const [step, setStep] = useState<MobileSignUpStep>(initialStep);
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  // ACCT-NEWS-01: unticked until the person ticks it.
  const [newsOptIn, setNewsOptIn] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"signup" | "verify" | "resend" | null>(null);
  // An i18n key, translated at render so it follows a language switch.
  const [notice, setNotice] = useState<Notice | null>(null);
  const passwordRef = useRef<TextInputInstance>(null);
  const confirmRef = useRef<TextInputInstance>(null);

  const fail = (key: string, err?: unknown) => setNotice({ kind: "error", key, values: signInErrorValues(err ?? null) });

  const submitSignUp = async () => {
    const address = email.trim();
    if (!address) return;
    const problem = checkSignUpInput(address, password, confirm, isDisposableEmail);
    if (problem) {
      fail(`signup.errors.${problem}`);
      return;
    }
    setBusy("signup");
    setNotice(null);
    try {
      await signup(address, password, uiLanguage, newsOptIn, "mobile");
      log.info("signup.done", { newsOptIn });
      setEmail(address);
      setPassword("");
      setConfirm("");
      setStep("verify");
      setNotice({ kind: "info", key: "verifyEmail.sent" });
    } catch (err) {
      const failure = classifySignUpError(err);
      log.warn("signup.failed", { failure });
      fail(failure === "rateLimited" ? TOO_MANY_ATTEMPTS_KEY : `signup.errors.${failure}`, err);
    } finally {
      setBusy(null);
    }
  };

  const submitCode = async () => {
    if (!code.trim()) return;
    setBusy("verify");
    setNotice(null);
    try {
      const { token, user } = await verifyEmail(email.trim(), code.trim(), device);
      log.info("verify.done");
      await onSignedIn(token, user);
    } catch (err) {
      const failure = classifyVerifyEmailError(err);
      log.warn("verify.failed", { failure });
      fail(failure === "rateLimited" ? TOO_MANY_ATTEMPTS_KEY : `verifyEmail.errors.${failure}`, err);
    } finally {
      setBusy(null);
    }
  };

  const resend = async () => {
    if (!email.trim()) return;
    setBusy("resend");
    setNotice(null);
    try {
      await resendVerification(email.trim());
      setNotice({ kind: "info", key: "verifyEmail.sent" });
    } catch (err) {
      const failure = classifyResendVerificationError(err);
      log.warn("resend.failed", { failure });
      fail(isRateLimited(err) ? TOO_MANY_ATTEMPTS_KEY : `verifyEmail.errors.${failure}`, err);
    } finally {
      setBusy(null);
    }
  };

  const noticeView = notice ? (
    <View
      testID="signup-notice"
      style={[
        styles.notice,
        notice.kind === "error"
          ? { borderColor: "rgba(255,99,99,0.4)", backgroundColor: "rgba(255,99,99,0.1)" }
          : { borderColor: `${theme.colors.accent}44`, backgroundColor: "rgba(255,170,84,0.08)" },
      ]}
    >
      <Text accessibilityRole="alert" style={[styles.noticeText, { color: notice.kind === "error" ? "#ff7f7f" : theme.colors.accent }]}>
        {t(notice.key, notice.values)}
      </Text>
    </View>
  ) : null;

  if (step === "verify") {
    return (
      <View testID="verify-email" style={styles.stack}>
        <Text style={[styles.title, { color: theme.colors.text }]}>{t("verifyEmail.title")}</Text>
        <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>{t("verifyEmail.subtitle")}</Text>
        {noticeView}
        <View style={styles.fields}>
          <MobileAuthInput testID="verify-email-address" icon={Mail} value={email} onChangeText={setEmail} placeholder={t("signup.emailLabel")} keyboardType="email-address" autoCapitalize="none" textContentType="emailAddress" autoComplete="email" />
          <MobileAuthInput testID="verify-code" icon={Lock} value={code} onChangeText={setCode} placeholder={t("verifyEmail.codeLabel")} textContentType="oneTimeCode" autoComplete="one-time-code" returnKeyType="done" onSubmitEditing={() => void submitCode()} />
        </View>
        <MobileAuthButton
          testID="verify-submit"
          label={busy === "verify" ? t("verifyEmail.verifying") : t("verifyEmail.submit")}
          onPress={() => void submitCode()}
          disabled={busy !== null}
        />
        <View style={styles.links}>
          <MobileAuthLink
            label={(busy === "resend" ? t("verifyEmail.sending") : t("verifyEmail.resend")).toUpperCase()}
            color={theme.colors.accent}
            style={styles.linkText}
            onPress={() => void resend()}
          />
          <MobileAuthLink label={t("verifyEmail.backToSignIn").toUpperCase()} color={theme.colors.textMuted} style={styles.linkText} onPress={() => onSignIn(email.trim())} />
        </View>
      </View>
    );
  }

  return (
    <View testID="sign-up" style={styles.stack}>
      <Text style={[styles.title, { color: theme.colors.text }]}>{t("signup.title")}</Text>
      <Text style={[styles.subtitle, { color: theme.colors.textMuted }]}>{t("signup.subtitle")}</Text>
      {noticeView}
      <View style={styles.fields}>
        <MobileAuthInput testID="signup-email" icon={Mail} value={email} onChangeText={setEmail} placeholder={t("signup.emailLabel")} keyboardType="email-address" autoCapitalize="none" textContentType="emailAddress" autoComplete="email" returnKeyType="next" onSubmitEditing={() => passwordRef.current?.focus()} />
        <MobileAuthInput testID="signup-password" icon={Lock} value={password} onChangeText={setPassword} placeholder={t("signup.passwordLabel")} secureTextEntry textContentType="newPassword" autoComplete="new-password" inputRef={passwordRef} returnKeyType="next" onSubmitEditing={() => confirmRef.current?.focus()} />
        <MobileAuthInput testID="signup-confirm" icon={Lock} value={confirm} onChangeText={setConfirm} placeholder={t("signup.confirmLabel")} secureTextEntry textContentType="newPassword" autoComplete="new-password" inputRef={confirmRef} returnKeyType="done" onSubmitEditing={() => void submitSignUp()} />
      </View>
      <Pressable
        testID="signup-news"
        accessibilityRole="checkbox"
        accessibilityState={{ checked: newsOptIn }}
        onPress={() => setNewsOptIn((value) => !value)}
        style={styles.newsRow}
      >
        <View style={[styles.box, { borderColor: newsOptIn ? theme.colors.accent : theme.colors.border, backgroundColor: newsOptIn ? theme.colors.accent : "transparent" }]}>
          {newsOptIn ? <Check size={14} color={theme.accentTextHex} /> : null}
        </View>
        <Text style={[styles.newsText, { color: theme.colors.textMuted }]}>{newsOptInText(language).newsBox}</Text>
      </Pressable>
      <MobileSignUpTermsNotice language={language} />
      <MobileAuthButton
        testID="signup-submit"
        label={busy === "signup" ? t("signup.creating") : t("signup.button")}
        onPress={() => void submitSignUp()}
        disabled={busy !== null}
      />
      {providerRows}
      <View style={styles.links}>
        <MobileAuthLink
          label={`${t("signup.haveAccountPrompt")} ${t("signup.signIn")}`.toUpperCase()}
          color={theme.colors.textMuted}
          style={styles.linkText}
          onPress={() => onSignIn(email.trim())}
        />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  stack: { gap: 12 },
  title: { fontSize: 18, fontWeight: "800", textAlign: "center" },
  subtitle: { fontSize: 12, lineHeight: 18, textAlign: "center" },
  fields: { gap: 10 },
  notice: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10 },
  noticeText: { fontSize: 12, textAlign: "center" },
  newsRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 2 },
  box: { width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, alignItems: "center", justifyContent: "center", marginTop: 1 },
  newsText: { flex: 1, fontSize: 12, lineHeight: 18 },
  legal: { fontSize: 11, lineHeight: 17, textAlign: "center" },
  links: { gap: 6, alignItems: "center", marginTop: 4 },
  linkText: { fontSize: 11, fontWeight: "900", letterSpacing: 1.8, textAlign: "center" },
});
