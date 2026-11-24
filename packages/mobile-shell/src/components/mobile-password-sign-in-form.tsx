/**
 * The phones' email-and-password sign-in (Badger phone and TV, Parrot phone): {@link useMobilePasswordSignIn} holds the
 * form's state and signs in; {@link MobilePasswordSignInForm} draws its notice, the email, password and (when the account
 * asks for it) two-factor fields, the sign-in button and "Forgot password?". The keyboard walks the form: Next on the
 * email moves to the password, Done on the last field signs in (UX-PHONE-08, UX-TV-16). After a Google, Apple or
 * Microsoft return that asks for the account's second step, the code field alone finishes that sign-in (ACCT-SIGNIN-05).
 * Notices are i18n keys, translated at render so they follow a language switch.
 */
import React, { useRef, useState } from "react";
import { StyleSheet, Text, View, type TextInputInstance } from "react-native";
import { ArrowRight, Lock, Mail } from "lucide-react-native";
import { ApiError } from "@space/shared/api";
import { classifySignInError, signInErrorDetails, signInErrorMessageKey, signInErrorValues } from "@space/shared/signInError";
import type { ProviderSignInNotice } from "../provider-sign-in";
import { useTranslation } from "../i18n";
import { scopeLogger } from "../logger";
import { useMobileShellTheme } from "../theme";
import { MobileAuthButton, MobileAuthInput, MobileAuthLink } from "./mobile-auth-form";

const log = scopeLogger("login");

/** A provider sign-in that came back asking for the account's second step, and its trade in progress. */
export type MobilePasswordSignInProviderStep = {
  method: "totp" | "email" | null;
  finishing: boolean;
  submit: (code: string) => Promise<void>;
};

export type UseMobilePasswordSignInInput = {
  /** Signs in with the app's device name; throws the API's error (two-factor, unverified, wrong password, …). */
  login: (email: string, password: string, code?: string) => Promise<void>;
  /** The provider sign-in's second step, when one is waiting (`useMobileProviderSignIn().secondStep`). */
  providerStep?: MobilePasswordSignInProviderStep;
  /** ACCT-AUTH-10: the account's email was never verified; the app opens the sign-up's code step. Absent (TV): an error. */
  onUnverified?: () => void;
  /**
   * The line over the form. The app holds it because the provider sign-in's answers and the password reset's "done"
   * show there too, and the provider hook is built before this one.
   */
  notice: ProviderSignInNotice | null;
  setNotice: (notice: ProviderSignInNotice | null) => void;
};

/** The form's state and its sign-in, as {@link MobilePasswordSignInForm} draws it. */
export type MobilePasswordSignIn = {
  email: string;
  setEmail: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  code: string;
  setCode: (value: string) => void;
  /** The second step asked for (the password's or the provider's), else null: the code field shows while set. */
  codeMethod: "totp" | "email" | null;
  /** A sign-in or the provider's second step is in flight. */
  working: boolean;
  notice: ProviderSignInNotice | null;
  setNotice: (notice: ProviderSignInNotice | null) => void;
  submit: () => Promise<void>;
};

export const useMobilePasswordSignIn = ({
  login,
  providerStep,
  onUnverified,
  notice,
  setNotice,
}: UseMobilePasswordSignInInput): MobilePasswordSignIn => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState<null | "totp" | "email">(null);
  const [busy, setBusy] = useState(false);
  const providerMethod = providerStep?.method ?? null;
  const codeMethod = providerMethod ?? needsCode;
  const working = busy || !!providerStep?.finishing;

  const submit = async () => {
    if (providerStep?.method) {
      if (!code.trim()) return;
      setNotice(null);
      await providerStep.submit(code.trim());
      return;
    }
    if (!email.trim() || !password) return;
    setNotice(null);
    setBusy(true);
    try {
      await login(email.trim(), password, needsCode ? code.trim() : undefined);
    } catch (err) {
      const failure = classifySignInError(err);
      // Never the credentials: the kind, the HTTP status and the API's error code (ACCT-AUTH-11).
      log.warn("login.failed", { failure, ...signInErrorDetails(err) });
      if (failure === "twoFactorRequired" && err instanceof ApiError) {
        const method = err.payload?.method === "totp" ? "totp" : "email";
        setNeedsCode(method);
        setNotice({ kind: "info", key: method === "totp" ? "login.infoTotp" : "login.infoEmail" });
      } else if (failure === "emailNotVerified" && onUnverified) {
        onUnverified();
      } else {
        setNotice({ kind: "error", key: signInErrorMessageKey(failure), values: signInErrorValues(err) });
      }
    } finally {
      setBusy(false);
    }
  };

  return { email, setEmail, password, setPassword, code, setCode, codeMethod, working, notice, setNotice, submit };
};

/** The notice box over a sign-in form (also the provider sign-in's and the password reset's words). */
export const MobileSignInNoticeBox = ({ notice }: { notice: ProviderSignInNotice }) => {
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  const error = notice.kind === "error";
  return (
    <View
      testID="login-notice"
      style={[styles.notice, error ? styles.errorNotice : [styles.infoNotice, { borderColor: `${theme.colors.accent}44` }]]}
    >
      <Text style={[styles.noticeText, { color: error ? "#ff7f7f" : theme.colors.accent }]}>{t(notice.key, notice.values)}</Text>
    </View>
  );
};

export type MobilePasswordSignInFormProps = {
  form: MobilePasswordSignIn;
  /** "Forgot password?": the app opens `MobilePasswordReset`. */
  onForgot: () => void;
};

export const MobilePasswordSignInForm = ({ form, onForgot }: MobilePasswordSignInFormProps) => {
  const { t } = useTranslation();
  const theme = useMobileShellTheme();
  const passwordRef = useRef<TextInputInstance>(null);
  const codeRef = useRef<TextInputInstance>(null);
  const signIn = () => void form.submit();
  return (
    <>
      {form.notice ? <MobileSignInNoticeBox notice={form.notice} /> : null}
      <View style={styles.fields}>
        <MobileAuthInput
          testID="login-email"
          icon={Mail}
          value={form.email}
          onChangeText={form.setEmail}
          placeholder={t("login.emailLabel")}
          keyboardType="email-address"
          textContentType="emailAddress"
          autoComplete="email"
          returnKeyType="next"
          onSubmitEditing={() => passwordRef.current?.focus()}
        />
        <MobileAuthInput
          testID="login-password"
          icon={Lock}
          value={form.password}
          onChangeText={form.setPassword}
          placeholder={t("login.passwordLabel")}
          secureTextEntry
          textContentType="password"
          autoComplete="current-password"
          inputRef={passwordRef}
          {...(form.codeMethod
            ? { returnKeyType: "next" as const, onSubmitEditing: () => codeRef.current?.focus() }
            : { returnKeyType: "done" as const, onSubmitEditing: signIn })}
        />
        {form.codeMethod ? (
          <MobileAuthInput
            testID="login-two-factor"
            icon={Lock}
            value={form.code}
            onChangeText={form.setCode}
            placeholder={t("login.twoFactorPlaceholder")}
            textContentType="oneTimeCode"
            autoComplete="one-time-code"
            inputRef={codeRef}
            returnKeyType="done"
            onSubmitEditing={signIn}
          />
        ) : null}
      </View>
      <MobileAuthButton
        testID="login-submit"
        label={form.working ? t("login.signingIn") : t("login.button")}
        onPress={signIn}
        disabled={form.working}
        icon={<ArrowRight size={18} color={theme.accentTextHex} />}
      />
      <MobileAuthLink testID="login-forgot" label={t("login.reset.button").toUpperCase()} color={theme.colors.textMuted} style={styles.link} onPress={onForgot} />
    </>
  );
};

const styles = StyleSheet.create({
  fields: { gap: 10, alignSelf: "stretch" },
  notice: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, alignSelf: "stretch" },
  errorNotice: { borderColor: "rgba(255,99,99,0.4)", backgroundColor: "rgba(255,99,99,0.1)" },
  infoNotice: { backgroundColor: "rgba(255,170,84,0.08)" },
  noticeText: { fontSize: 12, textAlign: "center" },
  link: { fontSize: 11, fontWeight: "900", letterSpacing: 1.8, textAlign: "center", marginTop: 4 },
});
